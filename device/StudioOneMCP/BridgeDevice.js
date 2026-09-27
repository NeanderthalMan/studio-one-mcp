// Studio One 5's controlsurfacedevice.js uses PreSonus.SysexBuffer without including
// the file that defines it, so load midiprotocol.js first.
include_file("resource://com.presonus.musicdevices/sdk/midiprotocol.js");
include_file("resource://com.presonus.musicdevices/sdk/controlsurfacedevice.js");

class BridgeDevice extends PreSonus.ControlSurfaceDevice {}

function createBridgeDevice() {
    return new BridgeDevice();
}
