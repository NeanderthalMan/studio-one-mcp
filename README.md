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
| `live_song` | The open song as it is right now, unsaved changes included: title, file path, transport (playing, recording, loop, position, tempo, loop range, precount, preroll), track count, selected tracks. |
| `live_tracks` | Tracks with media type, colour, mixer channel, number of takes, selection, and events (name, start, end, length in seconds, muted). |
| `live_select_track` | Select a track by name, so that selection-based commands act on it. |
| `live_transport` | Press a transport button: play, stop, record, return to zero, rewind or forward a bar, go to the loop start or end, toggle loop, click, precount or preroll. |
| `live_set_transport` | Set the tempo, the playhead position (in seconds, or bars like `"9.1.1.0"`), and loop, precount or preroll on or off. |
| `live_markers` | Markers with number, position (seconds and bars) and name (from the last save). Reading them briefly moves the playhead and puts it back, so it refuses while playing. Studio One only has recall commands for markers 1 to 20. |
| `live_add_marker` / `live_delete_marker` | Add a marker at a position, or delete one by number or position. The playhead is left where it was. |
| `live_select_events` | Select every event on some tracks or on all of them, or clear the selection. Selection-based commands then act on those events, e.g. `Event/Mute Events`, `Edit/Split at Cursor`, `Event/Quantize`, `Track/Activate Next Layer` (switch takes), `Edit/Undo`. |
| `live_set_loop` | Set the loop range in seconds or bars (e.g. `"9.1.1.0"` to `"17.1.1.0"`), and turn looping on or off. |
| `live_takes` | A track's takes: list them, switch to the next or previous take, or unpack them to separate tracks. |
| `live_track_state` | Arm, monitor, mute, solo, hide or duplicate a track by name, or show all tracks. |
| `live_edit_events` | Clip edits on one track: mute or unmute, quantize, transpose, split or trim at a time, merge, delete. |
| `live_add_track` | Add an audio (mono or stereo), instrument, folder or automation track. |
| `live_meters` | Peak dB for every channel. With `duration_ms`, it samples during playback and reports the highest peak and any clipping. |
| `live_save`, `live_undo`, `live_redo` | Save (optionally as a new version), and undo or redo edits, with a step count. |
| `live_channels` | Live mixer: volume, pan, mute, solo and record-arm for each channel. |
| `live_set_channel` | Set volume, pan, mute, solo or record-arm on a channel. |
| `live_command` | Run any of the roughly 1,000 Studio One commands, e.g. `Transport/Start`, `Edit/Undo`, `File/Save` or `View/Console`. `check_only` reports whether one is enabled without running it. |
| `live_list_commands` | Discover command names, optionally with whether each is enabled right now. |
| `live_eval` | Run JavaScript inside Studio One to explore its object model. Opt-in only. |

## Install

You need Node.js 20 or newer and Studio One.

```sh
git clone https://github.com/NeanderthalMan/studio-one-mcp.git
cd studio-one-mcp
npm install
npx studio-one-mcp setup
```

`setup` walks you through each step and asks before changing anything:

1. It finds your Studio One user profile.
2. It installs the **MCP Bridge** device into it.
3. It checks for a virtual MIDI port, which acts as the bridge's doorbell:
   - **macOS:** the built-in IAC Driver. `setup` can open Audio MIDI Setup for you. Tick **Device is online** under **IAC Driver**.
   - **Windows:** install [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html) and add a port named `studio-one-mcp`.
4. It registers the server with Claude Code (all projects) and, if you want, Claude Desktop. It backs up the Desktop config before editing it. For any other client, it prints the JSON to paste.
5. It shows the one step you do in Studio One: **Preferences… (⌘,)** on a Mac, **Options** on Windows → **External Devices → Add… → studio-one-mcp → MCP Bridge**. Set **Receive From** to your virtual MIDI port, and **Send To** to None. Restart Studio One first if it was running.
6. It waits for Studio One to answer.

`npm run setup` does the same thing. Use `--yes` to accept the defaults, `--dry-run` to see what it would do, and `--profile <dir>` to pick a profile.

If something doesn't work, run:

```sh
npx studio-one-mcp doctor      # or: npm run doctor
```

It checks every link in the chain and tells you how to fix the first broken one: Node, profile, Songs folder, device installed and current, MIDI port, Studio One running, bridge loaded, bridge answering, and MCP client registration.

To remove the device: `npx studio-one-mcp uninstall`, then remove **MCP Bridge** under External Devices.

**Without the live bridge:** the `song_*` tools need nothing but the MCP registration. They read your `.song` files directly.

### Configuration

| Env var | Default |
|---|---|
| `STUDIO_ONE_SONGS` | `~/Documents/Studio One/Songs` (colon-separated list) |
| `STUDIO_ONE_PROFILE` | newest `…/PreSonus/Studio One *` user folder |
| `STUDIO_ONE_MCP_MIDI_PORT` | first MIDI output whose name contains `IAC` |
| `STUDIO_ONE_MCP_HOME` | `~/Library/Application Support/studio-one-mcp` (the mailbox lives here) |

## How the live bridge works

Studio One runs control-surface scripts in an embedded SpiderMonkey engine. Scripts can read and write files but cannot open sockets, so the bridge is a folder. Studio One 5 also gives scripts no usable timer, so the bridge is event-driven. After writing a request, the server presses MIDI note 119 on a virtual MIDI bus (the macOS IAC Driver). The device's surface file maps that note, as a trigger control, to a toggle on a component parameter, and the component answers on each change.

```
status.json    device → client   session id; refreshed whenever the bridge runs
request.json   client → device   {id, op, args}, written atomically (tmp + rename)
response.json  device → client   {id, ok, result | error}
```

The client re-sends the press every 150 ms until a response arrives. The component answers each request id once, and the client sends one request at a time.

Two rules for anything that runs inside Studio One, both learned on 5.5.2:

- Never `throw`. An exception raised while Studio One is calling into a script becomes a modal **Scripting Error** dialog, even when the code catches it. While that dialog is open, some edits (mute, solo) silently do not apply. The device scripts return errors as values, and a test enforces it.
- Never call a member of a host object without first checking that it exists. A TypeError on a host object raises the same dialog.
- The same goes for code sent through `live_eval`. A `throw` there popped the dialog in testing, the first time in a session, even though the bridge catches it and reports the error.

## Testing

```sh
npm test            # unit and end-to-end tests; no Studio One needed
npm run test:live   # against a running Studio One with the bridge installed
```

The unit tests run the real device scripts under `node:vm` against a fake Studio One host (`test/helpers/s1host.js`). The live tests change only what they restore: one channel's mute, solo and volume, the tempo, the playhead, loop, the track selection, and a play/stop. They never record. They also add a marker at 3.25 s and delete it again, mute a track's events and unmute them, switch takes and back (in whichever direction moves: layers do not wrap), mute a track and mute it again (track mute is not on Studio One's undo stack, so an Undo there reverts the edit before it), and split a clip and add a track, each followed by Undo. File/Save is only checked, never run.

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
