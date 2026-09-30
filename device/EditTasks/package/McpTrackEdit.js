// studio-one-mcp track edit task ("Track/MCP Track Edit").
//
// A TrackEdit task gets what Studio One's own track scripts use (Add Bus for
// Selected Channels, Pack Folder…): context.functions with moveToFolder and
// colorizeEvent, functions.root.environment (the MixerConsole), and
// functions.root.createFunctions("DeviceEditFunctions") with connectChannel.
// The bridge writes operations to mailbox/track-edit-request.json, runs this
// task's command, and reads mailbox/track-edit-result.json. No dialog.
//
// Every host member is checked before use: a throw, or a call on a missing
// member, pops a modal Scripting Error dialog in Studio One.
include_file("McpEditConfig.js");

function mteUrl(name) { return Host.Url(McpEditConfig.mailbox + name); }

function mteRead(name) {
	if (!Host.IO.File(mteUrl(name)).exists()) return null;
	var f = Host.IO.openTextFile(mteUrl(name), "utf-8");
	if (!f) return null;
	var text = f.readLine();
	f.close();
	if (typeof text !== "string" || !text) return null;
	var value = null;
	try { value = JSON.parse(text.replace(/^﻿/, "")); } catch (_) { value = null; }
	return value;
}

function mteWrite(name, value) {
	var f = Host.IO.createTextFile(mteUrl(name), "utf-8");
	if (!f) return;
	f.writeString(JSON.stringify(value) + "\n");
	f.close();
}

function mteFn(obj, key) { return !!obj && typeof obj[key] === "function"; }

// Which of `names` exist on obj, and as what (for the probe).
function mteShape(obj, names) {
	var out = {};
	if (!obj) return null;
	for (var i = 0; i < names.length; i++) out[names[i]] = typeof obj[names[i]];
	return out;
}

// All mixer channels as [{ label, channel }], trying the list shapes seen in Studio One scripts.
function mteChannels(consoleObj) {
	var out = [];
	if (!mteFn(consoleObj, "getChannelList")) return out;
	// 1 is the only list kind Studio One's own scripts use; others are not guessed at.
	var list = consoleObj.getChannelList(1);
	if (!list) return out;
	var n = typeof list.numChannels === "number" ? list.numChannels : (typeof list.count === "number" ? list.count : 0);
	for (var i = 0; i < n; i++) {
		var ch = mteFn(list, "getChannel") ? list.getChannel(i) : (mteFn(list, "at") ? list.at(i) : null);
		if (!ch) continue;
		var label = typeof ch.label === "string" ? ch.label : (typeof ch.name === "string" ? ch.name : null);
		if (label === null) continue;
		out.push({ label: label, channel: ch });
	}
	return out;
}

function mteTracks(context) {
	var out = [];
	var tl = context.mainTrackList;
	if (!tl || typeof tl.numTracks !== "number" || !mteFn(tl, "getTrack")) return out;
	for (var i = 0; i < tl.numTracks; i++) {
		var t = tl.getTrack(i);
		if (!t) continue;
		var seen = false;
		for (var k = 0; k < out.length; k++) if (out[k] === t) seen = true;
		if (!seen) out.push(t);
	}
	return out;
}

function mteApply(context, ops) {
	var fns = context.functions;
	var root = fns ? fns.root : null;
	var env = root ? root.environment : null;
	var consoleObj = env && mteFn(env, "find") ? env.find("MixerConsole") : null;
	var results = [];
	for (var i = 0; i < ops.length; i++) {
		var op = ops[i] || {};
		var r = { op: op.op };
		if (op.op === "probe") {
			r.context = mteShape(context, ["functions", "mainTrackList", "editor", "iterator"]);
			r.functions = mteShape(fns, ["root", "moveToFolder", "colorizeEvent", "renameEvent", "addTrack", "removeTrack", "executeImmediately"]);
			r.root = mteShape(root, ["environment", "createFunctions"]);
			r.console = mteShape(consoleObj, ["getChannelList", "canConnectToBus", "canConnectToVCA"]);
			var list = consoleObj && mteFn(consoleObj, "getChannelList") ? consoleObj.getChannelList(1) : null;
			r.channelList = mteShape(list, ["numChannels", "count", "getChannel", "at", "numSelectedChannels", "getSelectedChannel"]);
			var chans = mteChannels(consoleObj);
			r.channelCount = chans.length;
			r.firstChannels = [];
			for (var c = 0; c < chans.length && c < 4; c++) r.firstChannels.push(chans[c].label);
			r.channel = chans.length ? mteShape(chans[0].channel, ["label", "name", "input", "getDestinationChannel", "connectTo"]) : null;
			var dev = root && mteFn(root, "createFunctions") ? root.createFunctions("DeviceEditFunctions") : null;
			r.deviceFunctions = mteShape(dev, ["connectChannel"]);
			var tracks = mteTracks(context);
			r.trackCount = tracks.length;
			r.track = tracks.length ? mteShape(tracks[0], ["name", "isFolder", "parentFolderID", "channel"]) : null;
		} else if (op.op === "route") {
			// { channel, to }: send a channel's output to another channel's input (a bus, the main out).
			var all = mteChannels(consoleObj);
			var src = null, dst = null, nSrc = 0, nDst = 0;
			for (var a = 0; a < all.length; a++) {
				if (all[a].label === op.channel) { src = all[a].channel; nSrc++; }
				if (all[a].label === op.to) { dst = all[a].channel; nDst++; }
			}
			var devf = root && mteFn(root, "createFunctions") ? root.createFunctions("DeviceEditFunctions") : null;
			if (nSrc !== 1) r.error = nSrc ? "channel name is ambiguous: " + op.channel : "no channel named " + op.channel;
			else if (nDst !== 1) r.error = nDst ? "destination name is ambiguous: " + op.to : "no channel named " + op.to;
			else if (!devf || !mteFn(devf, "connectChannel")) r.error = "connectChannel is not available";
			else if (!dst.input) r.error = op.to + " has no input to route to";
			else { devf.connectChannel(src, dst.input); r.done = true; }
		} else if (op.op === "folder") {
			// { tracks: [names], folder: name }: move tracks into an existing folder track.
			var ts = mteTracks(context);
			var folder = null;
			for (var b = 0; b < ts.length; b++) if (ts[b].name === op.folder && ts[b].isFolder) folder = ts[b];
			if (!folder) r.error = "no folder track named " + op.folder;
			else if (!mteFn(fns, "moveToFolder")) r.error = "moveToFolder is not available";
			else {
				r.moved = [];
				r.missing = [];
				var names = op.tracks && op.tracks.length ? op.tracks : [];
				for (var d = 0; d < names.length; d++) {
					var hit = null;
					for (var e = 0; e < ts.length; e++) if (ts[e].name === names[d] && ts[e] !== folder) hit = ts[e];
					if (hit) { fns.moveToFolder(folder, hit); r.moved.push(names[d]); } else r.missing.push(names[d]);
				}
			}
		} else {
			r.error = "unknown op " + op.op;
		}
		results.push(r);
	}
	return results;
}

function McpTrackEditTask() {
	this.interfaces = [Host.Interfaces.IEditTask];
	this.prepareEdit = function (context) { return Host.Results.kResultOk; };
	this.performEdit = function (context) {
		var req = mteRead("track-edit-request.json");
		if (!req || !req.id || !req.ops || typeof req.ops.length !== "number") {
			mteWrite("track-edit-result.json", { id: req && req.id ? req.id : null, error: "no track edit request" });
			return Host.Results.kResultOk;
		}
		mteWrite("track-edit-result.json", { id: req.id, results: mteApply(context, req.ops) });
		return Host.Results.kResultOk;
	};
}

function createMcpTrackEdit() { return new McpTrackEditTask(); }
