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
        let reply;
        try {
            reply = { id: req.id, session: this.session, ok: true, result: this.handle(req.op, req.args || {}) };
        } catch (e) {
            reply = { id: req.id, session: this.session, ok: false, error: String(e && e.message || e) };
        }
        reply.ms = Date.now() - now;
        this.mailbox.write("response.json", reply);
    }

    // ---- operations -------------------------------------------------------------

    handle(op, args) {
        switch (op) {
            case "ping": return { pong: true, session: this.session, time: Date.now() };
            case "channels": return this.component.channels();
            case "setChannel": return this.component.setChannel(args);
            case "command": return this.command(args);
            case "listCommands": return this.listCommands(args);
            case "eval": return this.evaluate(args);
            default: throw new Error("unknown op: " + op);
        }
    }

    command(args) {
        if (!args.category || !args.name) throw new Error("category and name are required");
        const ok = args.args
            ? Host.GUI.Commands.interpretCommand(args.category, args.name, false, Host.Attributes(args.args))
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
        return describe(fn(Host, PreSonus, this.component, describe), args.depth === undefined ? 2 : args.depth);
    }
}

function bridgeConfig() {
    const cfg = typeof BridgeConfig === "object" ? BridgeConfig : null;
    if (!cfg || typeof cfg.mailbox !== "string" || cfg.mailbox.indexOf("file:///") !== 0) {
        Host.Console.writeLine("studio-one-mcp: BridgeConfig.js missing or invalid; bridge disabled");
        return null;
    }
    return cfg;
}
