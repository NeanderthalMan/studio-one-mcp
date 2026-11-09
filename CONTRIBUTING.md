# Contributing

Thanks for helping! Studio One has no public API, so most of this project is
finding out what its scripting engine and `.song` files actually do. Bug reports
from Studio One versions other than 5.5.2, and from Windows, are just as useful as
code.

## Getting set up

```sh
git clone https://github.com/NeanderthalMan/studio-one-mcp.git
cd studio-one-mcp
npm install
npm test               # no Studio One needed
npx studio-one-mcp setup   # registers this checkout and installs its bridge device
```

After you change anything under `device/`, run `setup` again and **restart
Studio One**. It loads the device and the edit-task extension only at startup.
`doctor` tells you when the running bridge is older than the installed one.

## How the code is laid out

| Where | What | Runs in |
|---|---|---|
| `src/server.js` | Every MCP tool: its name, description, input schema, and a call into a module below | Node |
| `src/song.js`, `src/xml.js`, `src/diff.js`, … | `song_*` tools: read `.song` files (zip of XML) | Node |
| `src/bridge.js`, `src/midi.js` | Write `request.json` to the mailbox, ring MIDI note 119, wait for `response.json` | Node |
| `src/tracks.js`, `src/events.js`, `src/arranger.js`, … | `live_*` tools: build requests and shape replies | Node |
| `device/StudioOneMCP/BridgeCore.js` | The ops the bridge answers (`handle(op, args)`) | Studio One (SpiderMonkey) |
| `device/StudioOneMCP/BridgeComponent.js` | The control-surface component that owns the mixer and transport | Studio One |
| `device/EditTasks/` | An edit task for edits only an editor context can make (notes, track edits) | Studio One |
| `src/setup/` | `setup`, `doctor`, `uninstall` | Node |

A new live tool is usually: an op in `BridgeCore.js`, a small module in `src/`,
a tool in `server.js`, unit tests, and a live test that restores the song.

## Rules for device code

Studio One turns any exception raised while it is calling a script, and any
`TypeError` on a host object, into a modal **Scripting Error** dialog. While one is
open, some edits silently do not apply. So, in `device/`:

- Never `throw`. Return `fail("…")` values instead.
- Check that a host member exists before you call it.
- Don't keep observers registered when Studio One quits. It crashes (see the
  history of `live_changes`).

To find out what a host object offers, enable `live_eval` (answer yes when `setup`
asks, or `npm run install-device -- --allow-eval`) and probe on a scratch song. Leave eval off otherwise.

## Tests

- `npm test` runs the real device scripts under `node:vm` against a fake host
  (`test/helpers/s1host.js`). Every change needs these to pass, and new ops need
  a test here.
- `npm run test:live` runs against a running Studio One. Use a **scratch song**.
  The suite changes only what it restores, but it does edit the open song. Live
  tests never record, save or bounce, and new ones must follow the same rule.

If you can only test on one Studio One version or OS, say which in the PR. That
is useful information, not a weakness.

## Pull requests

- Keep each PR to one thing, and include tests.
- Update the tool list in `README.md` if you add or change a tool.
- Describe how you checked it in Studio One: version, OS, and what you clicked.

## Good first issues

Look for the [`good first issue`](https://github.com/NeanderthalMan/studio-one-mcp/labels/good%20first%20issue)
label. Testing on Studio One 6, 7 or Studio Pro 8, or on Windows, and reporting what
breaks is always welcome, even with no code.
