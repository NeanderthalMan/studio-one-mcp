// studio-one-mcp bridge core, shared by the device and component scripts.
//
// Studio One's script engine has no sockets, so the bridge talks to the outside
// world through a mailbox folder (path set in BridgeConfig.js at install time):
//
//   status.json    written by us: {protocol, session, startedAt, heartbeat, component}
//   request.json   written by the client (atomically): {id, op, args}
//   response.json  written by us: {id, session, ok, result | error, ms}
//
// Runs in the component script, the only one of the two with a Host object.
// Studio One 5 has no usable script timer, so the bridge is event-driven: after
// writing request.json the client sends a MIDI CC that the surface maps to the
// component's bridgeTick parameter, and each change calls tick().

const kProtocol = 1;
const kHeartbeatMs = 2000;

function newSession() {
    let s = "";
    for (let i = 0; i < 4; i++)
        s += ("00000000" + Math.floor(Math.random() * 4294967296).toString(16)).slice(-8);
    return s;
}

// JSON-safe view of anything, including host objects that JSON.stringify chokes on.
function describe(value, depth) {
    if (depth === undefined) depth = 2;
    if (value === null || value === undefined) return value === undefined ? "<undefined>" : null;
    const t = typeof value;
    if (t === "number" || t === "boolean" || t === "string") return value;
    if (t === "function") return "<function>";
    if (Array.isArray(value)) return depth <= 0 ? "<array " + value.length + ">" : value.slice(0, 200).map(v => describe(v, depth - 1));
    try {
        const json = JSON.stringify(value);
        if (json !== undefined && json !== "{}") return JSON.parse(json);
    } catch (_) {}
    if (depth <= 0) return "<object>";
    const out = {};
    let keys = [];
    try { keys = Object.getOwnPropertyNames(value); } catch (_) {}
    try { for (const k in value) if (keys.indexOf(k) < 0) keys.push(k); } catch (_) {}
    for (const k of keys.slice(0, 200)) {
        try { out[k] = describe(value[k], depth - 1); } catch (e) { out[k] = "<error " + e + ">"; }
    }
    if (!keys.length) { try { out["<string>"] = String(value); } catch (_) {} }
    return out;
}

class Mailbox {
    constructor(dirUrl) { this.dir = dirUrl.slice(-1) === "/" ? dirUrl : dirUrl + "/"; }
    url(name) { return Host.Url(this.dir + name); }
    read(name) {
        let f = null;
        try {
            if (!Host.IO.File(this.url(name)).exists()) return null;
            f = Host.IO.openTextFile(this.url(name), "utf-8");
            if (!f) return null;
            // The client always writes a single line of JSON.
            const text = f.readLine();
            return typeof text === "string" && text ? JSON.parse(text.replace(/^﻿/, "")) : null;
        } catch (_) {
            return null; // half-written or not JSON yet; try again next tick
        } finally { if (f) f.close(); }
    }
    write(name, value) {
        let f = null;
        try {
            f = Host.IO.createTextFile(this.url(name), "utf-8");
            if (!f) return false;
            f.writeString(JSON.stringify(value) + "\n");
            return true;
        } finally { if (f) f.close(); }
    }
}

class Bridge {
    constructor(config, component) {
        this.config = config;
        this.component = component;
        this.mailbox = new Mailbox(config.mailbox);
        this.session = newSession();
        this.startedAt = Date.now();
        this.lastId = null;
        this.lastBeat = 0;
        this.clocks = {};       // tick counts per clock source, for diagnostics
        this.clockErrors = {};
        this.beat(true);
    }

    close() {
        try { this.mailbox.write("status.json", { protocol: kProtocol, session: this.session, closed: true, heartbeat: Date.now() }); } catch (_) {}
    }

    beat(force) {
        const now = Date.now();
        if (!force && now - this.lastBeat < kHeartbeatMs) return;
        this.lastBeat = now;
        this.mailbox.write("status.json", {
            protocol: kProtocol, session: this.session, startedAt: this.startedAt, heartbeat: now,
            allowEval: !!this.config.allowEval, clocks: this.clocks, clockErrors: this.clockErrors,
        });
    }

    tick(source) {
        if (source) this.clocks[source] = (this.clocks[source] || 0) + 1;
        const now = Date.now();
        this.beat(false);
        const req = this.mailbox.read("request.json");
        if (!req || typeof req.id !== "string" || req.id === this.lastId) return;
        this.lastId = req.id;
        let result;
        try {
            result = this.handle(req.op, req.args || {});
        } catch (e) {
            result = fail(e && e.message || e); // only reachable for plain-JS errors
        }
        const reply = isFail(result)
            ? { id: req.id, session: this.session, ok: false, error: result.bridgeError }
            : { id: req.id, session: this.session, ok: true, result: result };
        reply.ms = Date.now() - now;
        this.mailbox.write("response.json", reply);
    }

    // ---- operations -------------------------------------------------------------
    //
    // Nothing in the device scripts uses `throw`: failures are fail() values.
    // Studio One turns exceptions raised while it is calling into a script (and
    // any TypeError on a host object, caught or not) into a modal "Scripting
    // Error" dialog, and while one is open some edits (mute, solo) silently do
    // not apply. So also: check that a host member exists before calling it.

    handle(op, args) {
        switch (op) {
            case "ping": return { pong: true, session: this.session, time: Date.now() };
            case "channels": return this.fromComponent(c => c.channels());
            case "setChannel": return this.fromComponent(c => c.setChannel(args));
            case "command": return this.command(args);
            case "listCommands": return this.listCommands(args);
            case "song": return this.song();
            case "tracks": return this.tracks(args);
            case "selectTrack": return this.selectTrack(args);
            case "transport": return this.transport(args);
            case "setTransport": return this.setTransport(args);
            case "markers": return this.markers();
            case "addMarker": return this.addMarker(args);
            case "deleteMarker": return this.deleteMarker(args);
            case "selectEvents": return this.selectEvents(args);
            case "setLoop": return this.setLoop(args);
            case "takes": return this.takes(args);
            case "save": return this.run("File", args.newVersion ? "Save New Version" : "Save");
            case "undo": return this.repeat("Edit", "Undo", args.steps);
            case "redo": return this.repeat("Edit", "Redo", args.steps);
            case "trackState": return this.trackState(args);
            case "editEvents": return this.editEvents(args);
            case "addTrack": return this.addTrack(args);
            case "meters": return this.fromComponent(c => c.meters());
            case "eval": return this.evaluate(args);
            default: return fail("unknown op: " + op);
        }
    }

    // Component methods report failure as { error } (see BridgeComponent.js).
    fromComponent(fn) {
        if (!this.component) return fail("mixer not available (no control-surface component)");
        const r = fn(this.component);
        if (r && !Array.isArray(r) && typeof r.error === "string") return fail(r.error);
        return r;
    }

    // checkOnly asks whether the command is currently enabled without running it
    // (the same query Studio One makes to grey out menu items).
    command(args) {
        if (!args.category || !args.name) return fail("category and name are required");
        const cmds = Host.GUI.Commands;
        if (!cmds.findCommand(String(args.category), String(args.name)))
            return fail("unknown command: " + args.category + "/" + args.name + " (see listCommands)");
        if (args.checkOnly) return { enabled: !!cmds.interpretCommand(args.category, args.name, true) };
        const ok = args.args
            ? cmds.interpretCommand(args.category, args.name, false, Host.Attributes(args.args))
            : cmds.interpretCommand(args.category, args.name);
        return { executed: !!ok };
    }

    listCommands(args) {
        const it = Host.GUI.Commands.newCommandIterator();
        const out = [];
        const filter = args.filter ? String(args.filter).toLowerCase() : null;
        while (it && !it.done()) {
            const c = it.next();
            if (!c) break;
            const entry = { category: String(c.category), name: String(c.name) };
            if (filter && (entry.category + " " + entry.name).toLowerCase().indexOf(filter) < 0) continue;
            if (args.withState) entry.enabled = !!Host.GUI.Commands.interpretCommand(entry.category, entry.name, true);
            out.push(entry);
        }
        return out;
    }

    // ---- song, tracks, transport (document object model) ----------------------

    transportPanel() {
        const tp = docObject("Environment/TransportPanel");
        return tp && has(tp, "findParameter", "function") ? tp : null;
    }

    transportState() {
        const tp = this.transportPanel();
        if (!tp) return fail("no song open");
        const param = n => tp.findParameter(n) || null;
        const val = n => { const p = param(n); return p ? p.value : null; };
        const time = n => { const p = param(n); return p ? { seconds: p.value, display: String(p.string) } : null; };
        return {
            playing: !!val("start"), recording: !!val("record"), loop: !!val("loop"),
            precount: !!val("precount"), preroll: !!val("preroll"),
            tempo: val("tempo"),
            position: time("primaryTime"),
            timeFormat: param("primaryTimeFormat") ? String(param("primaryTimeFormat").string) : null,
            loopRange: { start: time("loopStart"), end: time("loopEnd") },
        };
    }

    song() {
        const transport = this.transportState();
        if (isFail(transport)) return transport;
        const dm = appObject("DocumentManager");
        const doc = dm && has(dm, "activeDocument", "object") ? dm.activeDocument : null;
        const list = trackList();
        const path = doc && has(doc, "path", "object") && has(doc.path, "url", "string") ? doc.path.url : null;
        return {
            title: doc ? String(doc.title) : null,
            fileUrl: path,
            transport: transport,
            trackCount: list ? uniqueTracks(list).length : null,
            selectedTracks: list ? selectedTracks(list).map(t => String(t.name)) : [],
        };
    }

    tracks(args) {
        const list = trackList();
        if (!list) return fail("no song open");
        const withEvents = args.events !== false;
        const maxEvents = args.maxEvents === undefined ? 50 : args.maxEvents;
        const filter = args.name ? String(args.name).toLowerCase() : null;
        const selected = selectedTracks(list);
        const out = [];
        for (const t of uniqueTracks(list)) {
            const name = String(t.name);
            if (filter && name.toLowerCase().indexOf(filter) < 0) continue;
            const entry = {
                index: has(t, "trackIndex", "number") ? t.trackIndex : out.length,
                name: name,
                mediaType: has(t, "mediaType", "string") ? t.mediaType : null,
                color: has(t, "color", "number") ? "#" + ("000000" + (t.color & 0xffffff).toString(16)).slice(-6) : null,
                channel: t.channel && has(t.channel, "label", "string") ? t.channel.label : null,
                takes: t.layers && has(t.layers, "count", "number") ? t.layers.count : null,
                selected: selected.indexOf(t) >= 0,
            };
            if (withEvents) {
                const events = trackEvents(t);
                entry.eventCount = events.length;
                entry.events = events.slice(0, maxEvents);
            }
            out.push(entry);
        }
        return out;
    }

    selectTrack(args) {
        const list = trackList();
        if (!list) return fail("no song open");
        if (!has(list, "selectTrack", "function")) return fail("track selection not available");
        const matches = uniqueTracks(list).filter(t => String(t.name) === String(args.name));
        if (matches.length !== 1) return fail(matches.length ? "track name is ambiguous: " + args.name : "no track named " + args.name);
        if (args.exclusive !== false && has(list, "unselectAll", "function")) list.unselectAll();
        list.selectTrack(matches[0], true, false);
        return { selected: selectedTracks(list).map(t => String(t.name)) };
    }

    // Transport buttons map onto Studio One commands (see listCommands "Transport").
    transport(args) {
        const actions = {
            play: "Start", stop: "Stop", record: "Record", togglePlay: "Toggle Start",
            returnToZero: "Return to Zero", rewind: "Rewind Bar", forward: "Forward Bar",
            loopStart: "Goto Loop Start", loopEnd: "Goto Loop End", toggleLoop: "Toggle Loop",
            toggleClick: "Click", togglePrecount: "Precount", togglePreroll: "Preroll",
            locateSelection: "Locate Selection",
        };
        const name = actions[args.action];
        if (!name) return fail("action must be one of " + Object.keys(actions).join(", "));
        const r = this.command({ category: "Transport", name: name });
        if (isFail(r)) return r;
        const state = this.transportState();
        return { action: args.action, executed: r.executed, transport: isFail(state) ? null : state };
    }

    // Tempo (bpm) and position (seconds) are transport-panel parameters; loop,
    // precount and preroll are toggled through their commands when they differ.
    setTransport(args) {
        const tp = this.transportPanel();
        if (!tp) return fail("no song open");
        if (args.tempo !== undefined) {
            const p = tp.findParameter("tempo");
            if (!p || !has(p, "setValue", "function")) return fail("tempo parameter not available");
            if (typeof args.tempo !== "number" || args.tempo < p.min || args.tempo > p.max) return fail("tempo must be a number from " + p.min + " to " + p.max);
            p.setValue(args.tempo, true);
        }
        if (args.positionSeconds !== undefined) {
            const p = tp.findParameter("primaryTime");
            if (!p || !has(p, "setValue", "function")) return fail("position parameter not available");
            if (typeof args.positionSeconds !== "number" || args.positionSeconds < 0) return fail("positionSeconds must be a number >= 0");
            p.setValue(args.positionSeconds, true);
        }
        if (args.positionBars !== undefined) {
            const r = setTime(tp.findParameter("primaryTime"), args.positionBars);
            if (isFail(r)) return r;
        }
        const toggles = { loop: "Toggle Loop", precount: "Precount", preroll: "Preroll" };
        for (const key in toggles) {
            if (args[key] === undefined) continue;
            const state = this.transportState();
            if (isFail(state)) return state;
            if (!!args[key] !== state[key]) {
                const r = this.command({ category: "Transport", name: toggles[key] });
                if (isFail(r)) return r;
            }
        }
        return this.transportState();
    }

    // ---- markers --------------------------------------------------------------
    //
    // The marker track is not reachable from scripts, but its commands are:
    // "Recall Marker N" is enabled for each existing marker and moves the playhead
    // there. So positions are read by recalling each marker in turn and putting
    // the playhead back. Names are not exposed (the MCP server adds them from the
    // saved .song). Only markers 1-20 have recall commands.

    markerPositions() {
        const tp = this.transportPanel();
        if (!tp) return fail("no song open");
        const pt = tp.findParameter("primaryTime");
        if (!pt || !has(pt, "setValue", "function")) return fail("position parameter not available");
        const state = this.transportState();
        if (state.playing) return fail("stop playback first: reading markers moves the playhead");
        const C = Host.GUI.Commands;
        const home = pt.value;
        const out = [];
        for (let n = 1; n <= 20; n++) {
            const name = "Recall Marker " + n;
            if (!C.findCommand("Marker", name)) break;
            if (!C.interpretCommand("Marker", name, true)) continue;
            C.interpretCommand("Marker", name);
            out.push({ number: n, seconds: pt.value, display: String(pt.string) });
        }
        pt.setValue(home, true);
        return out;
    }

    markers() {
        const list = this.markerPositions();
        return isFail(list) ? list : { markers: list };
    }

    addMarker(args) {
        const tp = this.transportPanel();
        if (!tp) return fail("no song open");
        const pt = tp.findParameter("primaryTime");
        const home = pt.value;
        const at = args.seconds === undefined ? home : args.seconds;
        if (typeof at !== "number" || at < 0) return fail("seconds must be a number >= 0");
        pt.setValue(at, true);
        const r = this.command({ category: "Marker", name: "Insert" });
        pt.setValue(home, true);
        if (isFail(r)) return r;
        const list = this.markerPositions();
        return isFail(list) ? list : { added: r.executed, seconds: at, markers: list };
    }

    deleteMarker(args) {
        const list = this.markerPositions();
        if (isFail(list)) return list;
        const target = args.number !== undefined
            ? list.find(m => m.number === args.number)
            : list.find(m => typeof args.seconds === "number" && Math.abs(m.seconds - args.seconds) < 0.001);
        if (!target) return fail("no marker " + (args.number !== undefined ? "number " + args.number : "at " + args.seconds + "s"));
        const pt = this.transportPanel().findParameter("primaryTime");
        const home = pt.value;
        this.command({ category: "Marker", name: "Recall Marker " + target.number });
        const r = this.command({ category: "Marker", name: "Delete" });
        pt.setValue(home, true);
        if (isFail(r)) return r;
        const after = this.markerPositions();
        return isFail(after) ? after : { deleted: target, markers: after };
    }

    // ---- event selection ------------------------------------------------------
    //
    // Studio One's event commands (Event/Mute Events, Edit/Split at Cursor,
    // Track/Activate Next Layer...) act on the selection. This selects every
    // event on the named tracks (or on all tracks) so live_command can follow.

    selectEvents(args) {
        const list = trackList();
        if (!list) return fail("no song open");
        const C = Host.GUI.Commands;
        this.command({ category: "Edit", name: "Deselect All" });
        if (args.none) return { selectedTracks: selectedTracks(list).map(t => String(t.name)), events: "none" };
        if (args.all) {
            const r = this.command({ category: "Edit", name: "Select All" });
            if (isFail(r)) return r;
        } else {
            const names = Array.isArray(args.tracks) ? args.tracks : [args.track];
            if (!names.length || names.some(n => typeof n !== "string")) return fail("track (or tracks, or all) is required");
            for (let i = 0; i < names.length; i++) {
                const r = this.selectTrack({ name: names[i], exclusive: i === 0 });
                if (isFail(r)) return r;
            }
            const r = this.command({ category: "Edit", name: "Select All on Tracks" });
            if (isFail(r)) return r;
        }
        return {
            selectedTracks: selectedTracks(list).map(t => String(t.name)),
            eventCommandsEnabled: !!C.interpretCommand("Event", "Mute Events", true),
        };
    }

    // ---- more editing tools ---------------------------------------------------

    run(category, name) {
        const r = this.command({ category: category, name: name });
        if (isFail(r)) return r;
        if (!r.executed) return fail(category + "/" + name + " is not available right now");
        return r;
    }

    repeat(category, name, steps) {
        const n = steps === undefined ? 1 : steps;
        if (typeof n !== "number" || n < 1 || n > 50) return fail("steps must be 1 to 50");
        let done = 0;
        for (let i = 0; i < n; i++) {
            const r = this.command({ category: category, name: name });
            if (isFail(r)) return r;
            if (!r.executed) break;
            done++;
        }
        return { done: done };
    }

    // start/end: seconds (number) or a bar position string like "9.1.1.0".
    setLoop(args) {
        const tp = this.transportPanel();
        if (!tp) return fail("no song open");
        if (args.start !== undefined) { const r = setTime(tp.findParameter("loopStart"), args.start); if (isFail(r)) return r; }
        if (args.end !== undefined) { const r = setTime(tp.findParameter("loopEnd"), args.end); if (isFail(r)) return r; }
        if (args.enable !== undefined) {
            const state = this.transportState();
            if (!!args.enable !== state.loop) { const r = this.run("Transport", "Toggle Loop"); if (isFail(r)) return r; }
        }
        return this.transportState();
    }

    // Run fn with only the named track selected, then put the selection back.
    withTrack(name, fn) {
        const list = trackList();
        if (!list) return fail("no song open");
        const before = selectedTracks(list);
        const sel = this.selectTrack({ name: name });
        if (isFail(sel)) return sel;
        const result = fn(list);
        if (has(list, "unselectAll", "function")) list.unselectAll();
        for (const t of before) list.selectTrack(t, true, false);
        return result;
    }

    trackInfo(name) {
        const found = this.tracks({ name: name, maxEvents: 20 });
        if (isFail(found)) return found;
        return found.find(t => t.name === name) || null;
    }

    takes(args) {
        const actions = { list: null, next: "Activate Next Layer", previous: "Activate Previous Layer", unpack: "Unpack Layers to Tracks" };
        const action = args.action || "list";
        if (!(action in actions)) return fail("action must be one of " + Object.keys(actions).join(", "));
        if (action !== "list") {
            const r = this.withTrack(args.track, () => this.run("Track", actions[action]));
            if (isFail(r)) return r;
        } else if (!this.trackInfo(args.track)) {
            return fail("no track named " + args.track);
        }
        const t = this.trackInfo(args.track);
        return { track: args.track, action: action, takes: t ? t.takes : null, activeEvents: t ? t.events.map(e => e.name) : [] };
    }

    trackState(args) {
        const actions = { arm: "Arm", monitor: "Monitor", mute: "Mute", solo: "Solo", hide: "Hide", duplicate: "Duplicate", showAll: null };
        if (!(args.action in actions)) return fail("action must be one of " + Object.keys(actions).join(", "));
        if (args.action === "showAll") return this.run("Edit", "Show All Tracks");
        const r = this.withTrack(args.track, () => this.run("Track", actions[args.action]));
        if (isFail(r)) return r;
        const ch = this.component && has(this.component, "channels", "function") ? this.component.channels() : null;
        const t = this.trackInfo(args.track);
        const channel = Array.isArray(ch) && t ? ch.find(c => c.label === t.channel) || null : null;
        return { track: args.track, action: args.action, channel: channel };
    }

    // Selection-based clip edits on one track; the playhead is restored.
    editEvents(args) {
        const actions = {
            mute: ["Event", "Mute Events"], unmute: ["Event", "Unmute Events"], toggleMute: ["Event", "Toggle Mute"],
            quantize: ["Event", "Quantize"], transposeUp: ["Event", "Transpose Events Up"], transposeDown: ["Event", "Transpose Events Down"],
            split: ["Edit", "Split at Cursor"], trimStart: ["Event", "Trim Start to Cursor"], trimEnd: ["Event", "Trim End to Cursor"],
            merge: ["Event", "Merge Events"], delete: ["Edit", "Delete"],
        };
        const cmd = actions[args.action];
        if (!cmd) return fail("action must be one of " + Object.keys(actions).join(", "));
        const atCursor = ["split", "trimStart", "trimEnd"].indexOf(args.action) >= 0;
        if (atCursor && args.at === undefined) return fail(args.action + " needs at (seconds or bars)");
        const tp = this.transportPanel();
        if (!tp) return fail("no song open");
        const pt = tp.findParameter("primaryTime");
        const home = pt.value;
        if (atCursor) { const r = setTime(pt, args.at); if (isFail(r)) return r; }
        const r = this.withTrack(args.track, () => {
            const sel = this.command({ category: "Edit", name: "Select All on Tracks" });
            if (isFail(sel)) return sel;
            const done = this.run(cmd[0], cmd[1]);
            this.command({ category: "Edit", name: "Deselect All" });
            return done;
        });
        pt.setValue(home, true);
        if (isFail(r)) return r;
        const t = this.trackInfo(args.track);
        return { track: args.track, action: args.action, events: t ? t.events : [] };
    }

    addTrack(args) {
        const types = {
            audioMono: "Add Audio Track (mono)", audioStereo: "Add Audio Track (stereo)",
            instrument: "Add Instrument Track", folder: "Add Folder Track", automation: "Add Automation Track",
        };
        const name = types[args.type || "audioMono"];
        if (!name) return fail("type must be one of " + Object.keys(types).join(", "));
        const list = trackList();
        if (!list) return fail("no song open");
        const before = uniqueTracks(list);
        const r = this.run("Track", name);
        if (isFail(r)) return r;
        const added = uniqueTracks(list).filter(t => before.indexOf(t) < 0).map(t => String(t.name));
        return { added: added, trackCount: uniqueTracks(list).length };
    }

    // Arbitrary script, for exploring the host object model. Off unless the
    // installer was run with --allow-eval. Errors in the script are reported,
    // but a TypeError on a host object still raises Studio One's dialog.
    evaluate(args) {
        if (!this.config.allowEval) return fail("eval is disabled; reinstall the device with --allow-eval");
        let value;
        try {
            const fn = new Function("Host", "PreSonus", "component", "describe", String(args.code));
            value = fn(Host, PreSonus, this.component, describe);
        } catch (e) {
            return fail(e && e.message || e);
        }
        return describe(value, args.depth === undefined ? 2 : args.depth);
    }
}

// ---- helpers for the document object model --------------------------------------

function fail(message) { return { bridgeError: String(message) }; }
function isFail(value) { return !!value && typeof value === "object" && typeof value.bridgeError === "string"; }

function has(obj, key, type) {
    try { return obj !== null && obj !== undefined && typeof obj[key] === type; } catch (_) { return false; }
}

function appObject(name) {
    try { return Host.Objects.getObjectByUrl("://studioapp/" + name) || null; } catch (_) { return null; }
}

function docObject(path) {
    try { return Host.Objects.getObjectByUrl("://hostapp/DocumentManager/ActiveDocument/" + path) || null; } catch (_) { return null; }
}

function trackList() {
    const tl = docObject("TrackList");
    const list = tl && has(tl, "mainTrackList", "object") ? tl.mainTrackList : null;
    return list && has(list, "getTrack", "function") && has(list, "numTracks", "number") ? list : null;
}

// A track with takes shows up once per visible lane; they are the same object.
function uniqueTracks(list) {
    const out = [];
    for (let i = 0; i < list.numTracks; i++) {
        const t = list.getTrack(i);
        if (t && out.indexOf(t) < 0) out.push(t);
    }
    return out;
}

function selectedTracks(list) {
    const out = [];
    if (!has(list, "getSelectedTrack", "function") || !has(list, "numSelectedTracks", "number")) return out;
    for (let i = 0; i < list.numSelectedTracks; i++) {
        const t = list.getSelectedTrack(i);
        if (t && out.indexOf(t) < 0) out.push(t);
    }
    return out;
}

// A time parameter set from seconds (number) or a bar position string ("9.1.1.0").
function setTime(param, value) {
    if (!param || !has(param, "setValue", "function")) return fail("time parameter not available");
    if (typeof value === "number") {
        if (value < 0) return fail("time must be >= 0 seconds");
        param.setValue(value, true);
        return null;
    }
    if (typeof value === "string" && /^\d+(\.\d+){0,3}$/.test(value) && has(param, "fromString", "function")) {
        param.fromString(value);
        return null;
    }
    return fail("time must be seconds (number) or bars like \"9.1.1.0\"");
}

function seconds(time) {
    return time && has(time, "seconds", "number") ? Math.round(time.seconds * 1000) / 1000 : null;
}

function trackEvents(track) {
    const out = [];
    if (!has(track, "createIterator", "function")) return out;
    const it = track.createIterator();
    let ev;
    while (it && (ev = it.next())) {
        const start = seconds(ev.startTime), end = seconds(ev.endTime);
        out.push({
            name: has(ev, "name", "string") ? ev.name : "",
            start: start, end: end,
            length: start !== null && end !== null ? Math.round((end - start) * 1000) / 1000 : null,
            muted: !!ev.isMuted,
        });
    }
    return out;
}

function bridgeConfig() {
    const cfg = typeof BridgeConfig === "object" ? BridgeConfig : null;
    if (!cfg || typeof cfg.mailbox !== "string" || cfg.mailbox.indexOf("file:///") !== 0) {
        Host.Console.writeLine("studio-one-mcp: BridgeConfig.js missing or invalid; bridge disabled");
        return null;
    }
    return cfg;
}
