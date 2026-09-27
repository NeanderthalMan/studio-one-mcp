include_file("resource://com.presonus.musicdevices/sdk/controlsurfacedevice.js");

class BridgeDevice extends PreSonus.ControlSurfaceDevice {}

function createBridgeDevice() {
    return new BridgeDevice();
}
