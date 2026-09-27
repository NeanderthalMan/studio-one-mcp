// studio-one-mcp bridge component.
//
// Studio One's script engine has no sockets, so the bridge talks to the outside
// world through a mailbox folder (path set in BridgeConfig.js at install time):
//
//   status.json    written by us: {protocol, session, startedAt, heartbeat}
//   request.json   written by the client (atomically): {id, op, args}
//   response.json  written by us: {id, session, ok, result | error, ms}
//
// We poll request.json on a timer and answer each new id exactly once.

include_file("resource://com.presonus.musicdevices/sdk/controlsurfacecomponent.js");
include_file("BridgeConfig.js");

const kProtocol = 1;
const kPollMessage = "StudioOneMCP.Poll";
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
    constructor(dirUrl) { this.dir = dirUrl; }
    url(name) { return Host.Url(this.dir + name); }
    read(name) {
        let f = null;
        try {
            if (!Host.IO.File(this.url(name)).exists()) return null;
            f = Host.IO.openTextFile(this.url(name), "utf-8");
            if (!f) return null;
            // The client always writes a single line of JSON.
            const text = f.readLine();
            return typeof text === "string" && text ? JSON.parse(text) : null;
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

class BridgeComponent extends PreSonus.ControlSurfaceComponent {
    onInit(hostComponent) {
        super.onInit(hostComponent);
        this.active = false;
        try {
            const cfg = typeof BridgeConfig === "object" ? BridgeConfig : null;
            if (!cfg || typeof cfg.mailbox !== "string" || cfg.mailbox.indexOf("file:///") !== 0) {
                Host.Console.writeLine("studio-one-mcp: BridgeConfig.js missing or invalid; bridge disabled");
                return;
            }
            this.config = cfg;
            this.mailbox = new Mailbox(cfg.mailbox.slice(-1) === "/" ? cfg.mailbox : cfg.mailbox + "/");
            this.session = newSession();
            this.startedAt = Date.now();
            this.lastId = null;
            this.lastBeat = 0;
            this.active = true;
            this.beat(true);
            this.schedule();
        } catch (e) {
            this.active = false;
            try { Host.Console.writeLine("studio-one-mcp: init failed: " + e); } catch (_) {}
        }
    }

    onExit() {
        if (this.active) {
            this.active = false;
            try { this.mailbox.write("status.json", { protocol: kProtocol, session: this.session, closed: true, heartbeat: Date.now() }); } catch (_) {}
        }
        super.onExit();
    }

    notify(subject, msg) {
        if (msg && msg.id === kPollMessage) {
            if (this.active) { try { this.poll(); } finally { this.schedule(); } }
            return;
        }
        super.notify(subject, msg);
    }

    schedule() {
        if (!this.active) return;
        try { Host.Signals.postMessage(this, this.config.pollMs || 100, kPollMessage); }
        catch (e) { this.active = false; Host.Console.writeLine("studio-one-mcp: cannot schedule poll: " + e); }
    }

    beat(force) {
        const now = Date.now();
        if (!force && now - this.lastBeat < kHeartbeatMs) return;
        this.lastBeat = now;
        this.mailbox.write("status.json", {
            protocol: kProtocol, session: this.session, startedAt: this.startedAt, heartbeat: now,
            allowEval: !!this.config.allowEval,
        });
    }

    poll() {
        this.beat(false);
        const req = this.mailbox.read("request.json");
        if (!req || typeof req.id !== "string" || req.id === this.lastId) return;
        this.lastId = req.id;
        const t0 = Date.now();
        let reply;
        try {
            reply = { id: req.id, session: this.session, ok: true, result: this.handle(req.op, req.args || {}) };
        } catch (e) {
            reply = { id: req.id, session: this.session, ok: false, error: String(e && e.message || e) };
        }
        reply.ms = Date.now() - t0;
        this.mailbox.write("response.json", reply);
    }

    // ---- operations -------------------------------------------------------------

    handle(op, args) {
        switch (op) {
            case "ping": return { pong: true, session: this.session, time: Date.now() };
            case "channels": return this.channels();
            case "setChannel": return this.setChannel(args);
            case "command": return this.command(args);
            case "listCommands": return this.listCommands(args);
            case "eval": return this.evaluate(args);
            default: throw new Error("unknown op: " + op);
        }
    }

    channelElements() {
        const bank = this.model.root.find("mixer").find("channels");
        const out = [];
        for (let i = 0; i < 256; i++) {
            const el = bank.getElement(i);
            if (!el || !el.isConnected()) continue;
            const label = el.getParamValue(PreSonus.ParamID.kLabel);
            if (label !== undefined && label !== null && String(label) !== "") out.push({ index: i, el: el, label: String(label) });
        }
        return out;
    }

    readParam(el, id) {
        try { const v = el.getParamValue(id); return v === undefined ? null : v; } catch (_) { return null; }
    }

    channels() {
        return this.channelElements().map(c => ({
            index: c.index,
            label: c.label,
            type: this.readParam(c.el, PreSonus.ParamID.kChannelType),
            volume: this.readParam(c.el, PreSonus.ParamID.kVolume),
            pan: this.readParam(c.el, PreSonus.ParamID.kPan),
            mute: this.readParam(c.el, "mute"),
            solo: this.readParam(c.el, "solo"),
            recordArmed: this.readParam(c.el, PreSonus.ParamID.kRecord),
        }));
    }

    setChannel(args) {
        const fields = { volume: PreSonus.ParamID.kVolume, pan: PreSonus.ParamID.kPan, mute: "mute", solo: "solo", recordArmed: PreSonus.ParamID.kRecord };
        const param = fields[args.field];
        if (!param) throw new Error("field must be one of " + Object.keys(fields).join(", "));
        const matches = this.channelElements().filter(c => c.label === args.channel);
        if (matches.length !== 1) throw new Error(matches.length ? "channel name is ambiguous: " + args.channel : "no channel named " + args.channel);
        const el = matches[0].el;
        const before = this.readParam(el, param);
        el.setParamValue(param, args.value);
        return { channel: args.channel, field: args.field, before: before, after: this.readParam(el, param) };
    }

    command(args) {
        if (!args.category || !args.name) throw new Error("category and name are required");
        const attrs = args.args ? Host.Attributes(args.args) : undefined;
        const ok = attrs !== undefined
            ? Host.GUI.Commands.interpretCommand(args.category, args.name, false, attrs)
            : Host.GUI.Commands.interpretCommand(args.category, args.name);
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
            if (!filter || (entry.category + " " + entry.name).toLowerCase().indexOf(filter) >= 0) out.push(entry);
        }
        return out;
    }

    // Arbitrary script, for exploring the host object model. Off unless the
    // installer was run with --allow-eval.
    evaluate(args) {
        if (!this.config.allowEval) throw new Error("eval is disabled; reinstall the device with --allow-eval");
        const fn = new Function("Host", "PreSonus", "component", "describe", String(args.code));
        return describe(fn(Host, PreSonus, this, describe), args.depth === undefined ? 2 : args.depth);
    }
}

function createBridgeComponent() {
    return new BridgeComponent();
}
