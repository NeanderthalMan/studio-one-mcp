// studio-one-mcp bridge component: owns the mailbox bridge (BridgeCore.js) and
// gives it the mixer through this surface's channel bank.

include_file("resource://com.presonus.musicdevices/sdk/controlsurfacecomponent.js");
include_file("BridgeConfig.js");
include_file("BridgeCore.js");

class BridgeComponent extends PreSonus.ControlSurfaceComponent {
    onInit(hostComponent) {
        super.onInit(hostComponent);
        this.tickParam = hostComponent.paramList.addParam("bridgeTick");
        this.bridge = null;
        try {
            const cfg = bridgeConfig();
            if (cfg) this.bridge = new Bridge(cfg, this);
        } catch (e) {
            Host.Console.writeLine("studio-one-mcp: bridge init failed: " + e);
        }
        // Clock: the device script flips bridgeTick from its onIdle (BridgeDevice.js).
        // Do NOT use Host.GUI.addIdleTask with a script object here: on Studio One
        // 5.5.2 that crashed the app at launch (EXC_BAD_ACCESS in cclgui's timer).
        if (this.bridge) this.bridge.beat(true); // publish clockErrors even if no clock fires
    }

    onExit() {
        if (this.bridge) this.bridge.close();
        this.bridge = null;
        super.onExit();
    }

    clockTick(source) {
        if (!this.bridge) return;
        try { this.bridge.tick(source); }
        catch (e) { Host.Console.writeLine("studio-one-mcp: tick failed: " + e); }
    }

    paramChanged(param) {
        if (param === this.tickParam) return this.clockTick("deviceTick");
        super.paramChanged(param);
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
}

function createBridgeComponent() {
    return new BridgeComponent();
}
