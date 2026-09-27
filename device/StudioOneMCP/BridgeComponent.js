// studio-one-mcp bridge component: gives the bridge (owned by BridgeDevice.js,
// see BridgeCore.js) access to the mixer through this surface's channel bank.

include_file("resource://com.presonus.musicdevices/sdk/controlsurfacecomponent.js");

// Same global the bridge core reads (bridgeGlobals in BridgeCore.js). Not shared
// code on purpose: if device and component share one script context, including
// BridgeCore.js twice would redeclare its classes.
function componentRegistry() {
    const g = (typeof globalThis === "object" && globalThis) || this;
    if (!g.__studioOneMcp) g.__studioOneMcp = {};
    return g.__studioOneMcp;
}

class BridgeComponent extends PreSonus.ControlSurfaceComponent {
    onInit(hostComponent) {
        super.onInit(hostComponent);
        componentRegistry().component = this;
    }

    onExit() {
        const g = componentRegistry();
        if (g.component === this) g.component = null;
        super.onExit();
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
