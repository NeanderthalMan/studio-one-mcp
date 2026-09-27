// Studio One 5's controlsurfacedevice.js uses PreSonus.SysexBuffer without including
// the file that defines it, so load midiprotocol.js first.
include_file("resource://com.presonus.musicdevices/sdk/midiprotocol.js");
include_file("resource://com.presonus.musicdevices/sdk/controlsurfacedevice.js");

// Device scripts get a periodic onIdle() but no Host object; component scripts
// have Host but no idle callback. So the device's only job is to act as a clock:
// it flips the hidden "bridgeTick" control, which the surface maps to a component
// parameter, and the component (BridgeComponent.js) services the mailbox on each flip.
const kTickMs = 100;

class TickHandler extends PreSonus.ControlHandler {
    constructor() {
        super();
        this.name = "bridgeTick";
        this.state = 0;
    }
    tick() {
        this.state = this.state ? 0 : 1;
        this.updateValue(this.state);
    }
}

class BridgeDevice extends PreSonus.ControlSurfaceDevice {
    onInit(hostDevice) {
        super.onInit(hostDevice);
        this.ticker = new TickHandler();
        this.addReceiveHandler(this.ticker);
        this.lastTick = 0;
    }

    onIdle(time) {
        if (time - this.lastTick < kTickMs) return;
        this.lastTick = time;
        this.ticker.tick();
    }
}

function createBridgeDevice() {
    return new BridgeDevice();
}
