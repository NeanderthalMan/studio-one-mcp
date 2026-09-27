# studio-one-mcp

An [MCP](https://modelcontextprotocol.io) server for PreSonus **Studio One**. It lets Claude and other MCP clients read your songs and control a running Studio One.

Studio One has no public API, no OSC, and no network scripting. This server combines two things it *does* have:

| Layer | How | Needs Studio One running? |
|---|---|---|
| **`song_*` tools** | Parse `.song` files, which are zip archives of XML: tempo map, meter, markers, arranger sections, tracks, takes, clips, mixer, plug-in inserts and media. | No. Reflects the last save or autosave. |
| **`live_*` tools** | A small control-surface device, installed into Studio One, that answers requests through a local **file mailbox**. It uses Studio One's own JavaScript device SDK. | Yes |

Status: early. Developed against **Studio One 5.5.2 on macOS**. Paths for Windows and for Studio One 6/7 and Studio Pro 8 are wired in but untested.

## Tools

| Tool | What it does |
|---|---|
| `song_list` | Songs on disk, newest first. This includes songs that exist only as autosaves. |
| `song_read` | One song, as a `summary` (one line per track) or `full` (every take and clip). Positions are given as bar/beat and as seconds. |
| `song_history` | A song's autosaves, for comparing versions. |
| `live_status` | Whether the bridge is reachable. If not, it says why. |
| `live_channels` | Live mixer: volume, pan, mute, solo and record-arm for each channel. |
| `live_set_channel` | Set volume, pan, mute, solo or record-arm on a channel. |
| `live_command` | Run any Studio One command, e.g. `Transport/Start`, `Edit/Undo` or `Song/Save`. |
| `live_list_commands` | Discover command names. |
| `live_eval` | Run JavaScript inside Studio One to explore its object model. Opt-in only. |

## Install

```sh
npm install
npm test
```

Register the server with your MCP client. For Claude Code, the repo's `.mcp.json` already does this. Other clients use:

```json
{ "mcpServers": { "studio-one": { "command": "node", "args": ["/path/to/studio-one-mcp/src/server.js"] } } }
```

### Live bridge (optional)

```sh
npm run install-device            # add -- --allow-eval to enable live_eval
```

One-time MIDI setup (macOS): open **Audio MIDI Setup → Window → Show MIDI Studio → IAC Driver**, and tick **Device is online**.

Then restart Studio One and add the device once: **Studio One → Preferences… (⌘,) → External Devices → Add… → studio-one-mcp → MCP Bridge** (on Windows it is Studio One → Options). Set its **Receive From** to **IAC Driver Bus 1**, and leave Send To empty. `live_status` should now report `connected: true`.

To remove it: `node scripts/install-device.js --uninstall`, then remove the device in External Devices.

### Configuration

| Env var | Default |
|---|---|
| `STUDIO_ONE_SONGS` | `~/Documents/Studio One/Songs` (colon-separated list) |
| `STUDIO_ONE_PROFILE` | newest `…/PreSonus/Studio One *` user folder |
| `STUDIO_ONE_MCP_MIDI_PORT` | first MIDI output whose name contains `IAC` |
| `STUDIO_ONE_MCP_HOME` | `~/Library/Application Support/studio-one-mcp` (the mailbox lives here) |

## How the live bridge works

Studio One runs control-surface scripts in an embedded SpiderMonkey engine. Scripts can read and write files but cannot open sockets, so the bridge is a folder. Studio One 5 also gives scripts no usable timer, so the bridge is event-driven. After writing a request, the server sends MIDI CC 119 on a virtual MIDI bus (the macOS IAC Driver). The device's surface file maps that CC to a component parameter, and the component answers on each change.

```
status.json    device → client   session id; refreshed whenever the bridge runs
request.json   client → device   {id, op, args}, written atomically (tmp + rename)
response.json  device → client   {id, ok, result | error}
```

The client re-sends the CC every 150 ms until a response arrives. The component answers each request id once, and the client sends one request at a time.

Security: anything that can write to the mailbox folder, which means anything running as your user, can drive Studio One through it. With `--allow-eval`, it can also run arbitrary script inside Studio One. Keep the folder local, and leave eval off unless you are exploring.

## Format notes (`.song`)

These were verified on songs saved by Studio One 5.5.2:

- Events and markers with `timeFormat="2"` are in **quarter-note beats**. An audio event's `length` equals the clip's `frameCount / sampleRate × bpm / 60`.
- `TempoMapSegment@tempo` is **seconds per quarter note**, so 0.5 means 120 bpm.
- The transport's position and loop points are in **seconds**.
- Mixer `gain` is linear amplitude, and `pan` runs from 0 to 1 with 0.5 as centre.
- A track's takes are `Layers`, and `MediaTrack@activeLayer` picks the one that plays.
- Tracks link to mixer channels through `UID x:id="channelID"`, which matches the channel's `uniqueID`.
- Insert slots are the unnamed `<Attributes name="FXnn">` children of `Inserts`. Siblings with an `x:id` (`Presets`, `Combinator`) are rack state.

## Prior art

- [tiwadara/StudioOneMcp](https://github.com/tiwadara/StudioOneMcp) drives Studio One through MIDI, Mackie Control and UI automation. It is write-only.
- [Alari81/studio-control](https://github.com/Alari81/studio-control) proved the file-mailbox device pattern on Studio Pro 8. It uses a different, noncommercial license, and no code from it is included here.
- [CSources/Studio-Pro-Scripting-API-Reference](https://github.com/CSources/Studio-Pro-Scripting-API-Reference) is a community reference for the scripting API.

Studio One is a trademark of PreSonus Audio Electronics / Fender. This project is not affiliated with either.

## License

MIT
