// Studio One 5's controlsurfacedevice.js uses PreSonus.SysexBuffer without including
// the file that defines it, so load midiprotocol.js first.
include_file("resource://com.presonus.musicdevices/sdk/midiprotocol.js");
include_file("resource://com.presonus.musicdevices/sdk/controlsurfacedevice.js");
include_file("BridgeConfig.js");
include_file("BridgeCore.js");

// The device owns the bridge because only devices get a periodic onIdle callback.
class BridgeDevice extends PreSonus.ControlSurfaceDevice {
    onInit(hostDevice) {
        super.onInit(hostDevice);
        this.bridge = null;
        try {
            const cfg = bridgeConfig();
            if (cfg) this.bridge = new Bridge(cfg);
        } catch (e) {
            Host.Console.writeLine("studio-one-mcp: bridge init failed: " + e);
        }
    }

    onExit() {
        if (this.bridge) this.bridge.close();
        this.bridge = null;
        super.onExit();
    }

    onIdle(time) {
        if (!this.bridge) return;
        try { this.bridge.tick(); }
        catch (e) { Host.Console.writeLine("studio-one-mcp: tick failed: " + e); }
    }
}

function createBridgeDevice() {
    return new BridgeDevice();
}
