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
include_file("McpTrackOps.js");

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

// JSON-safe view of a host object, for the eval probe (as the bridge's describe).
function mteDescribe(value, depth) {
	if (value === null || value === undefined) return value === undefined ? "<undefined>" : null;
	var t = typeof value;
	if (t === "number" || t === "boolean" || t === "string") return value;
	if (t === "function") return "<function>";
	if (Array.isArray(value)) return depth <= 0 ? "<array " + value.length + ">" : value.slice(0, 200).map(function (v) { return mteDescribe(v, depth - 1); });
	try {
		var json = JSON.stringify(value);
		if (json !== undefined && json !== "{}") return JSON.parse(json);
	} catch (_) {}
	if (depth <= 0) return "<object>";
	var out = {}, keys = [];
	try { keys = Object.getOwnPropertyNames(value); } catch (_) {}
	try { for (var k in value) if (keys.indexOf(k) < 0) keys.push(k); } catch (_) {}
	for (var i = 0; i < keys.length && i < 200; i++) {
		try { out[keys[i]] = mteDescribe(value[keys[i]], depth - 1); } catch (e) { out[keys[i]] = "<error " + e + ">"; }
	}
	if (!keys.length) { try { out["<string>"] = String(value); } catch (_) {} }
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
			// { tracks: [names], folder: name, create }: move tracks into a folder track
			// (made first when create is set). The folder is expanded before the move,
			// as Studio One's own folder script does: tracks inside a collapsed folder
			// drop out of the track list that scripts see.
			var ts = mteTracks(context);
			var folder = null;
			for (var b = 0; b < ts.length; b++) if (ts[b].name === op.folder && ts[b].isFolder) folder = ts[b];
			if (!folder && op.create && mteFn(fns, "addTrack")) {
				fns.executeImmediately = true;
				var tl = context.mainTrackList;
				var at = tl && mteFn(tl, "getInsertPosition") ? tl.getInsertPosition() : 0;
				folder = fns.addTrack("FolderTrack", at, op.folder);
				r.created = !!folder;
			}
			var folders = context.editor && context.editor.model ? context.editor.model.folders : null;
			if (!folder) r.error = "no folder track named " + op.folder;
			else if (!mteFn(fns, "moveToFolder")) r.error = "moveToFolder is not available";
			else {
				if (folders && mteFn(folders, "isExpanded") && mteFn(folders, "toggleExpand") && !folders.isExpanded(folder)) folders.toggleExpand(folder);
				r.moved = [];
				r.missing = [];
				var names = op.tracks && op.tracks.length ? op.tracks : [];
				for (var d = 0; d < names.length; d++) {
					var hit = null;
					for (var e = 0; e < ts.length; e++) if (ts[e].name === names[d] && ts[e] !== folder) hit = ts[e];
					if (hit) { fns.moveToFolder(folder, hit); r.moved.push(names[d]); } else r.missing.push(names[d]);
				}
			}
		} else if (op.op === "renameEvents") {
			// { track, name, numbered }: rename every event on a track, like Studio
			// One's Rename Events ("name(01)", "name(02)"… in time order when numbered).
			var tt = mteTracks(context);
			var tr = null, nTr = 0;
			for (var g = 0; g < tt.length; g++) if (tt[g].name === op.track) { tr = tt[g]; nTr++; }
			if (nTr !== 1) r.error = nTr ? "track name is ambiguous: " + op.track : "no track named " + op.track;
			else if (typeof op.name !== "string" || !op.name) r.error = "renameEvents needs name";
			else if (!mteFn(fns, "renameEvent") || !mteFn(tr, "createIterator")) r.error = "renameEvent is not available";
			else {
				var evs = [];
				var it = tr.createIterator();
				var ev;
				while (it && (ev = it.next())) evs.push(ev);
				evs.sort(function (x, y) { return (x.startTime ? x.startTime.seconds : 0) - (y.startTime ? y.startTime.seconds : 0); });
				r.renamed = [];
				for (var h = 0; h < evs.length; h++) {
					var nm = op.numbered ? op.name + "(" + (h < 9 ? "0" : "") + (h + 1) + ")" : op.name;
					fns.renameEvent(evs[h], nm);
					r.renamed.push(nm);
				}
			}
		} else if (op.op === "eval") {
			// { code, depth }: probe code run with this task's context (editor, functions,
			// trackList), only when installed with --allow-eval. For exploring the model.
			if (!McpEditConfig.allowEval) r.error = "eval is disabled; reinstall the device with --allow-eval";
			else {
				try {
					var fn = new Function("context", "Host", String(op.code));
					r.value = mteDescribe(fn(context, Host), typeof op.depth === "number" ? op.depth : 2);
				} catch (ex) {
					r.error = String(ex && ex.message || ex);
				}
			}
		} else if (typeof mtoOps === "object" && mtoOps.hasOwnProperty(op.op)) {
			var more = mtoOps[op.op](context, op) || {};
			for (var key in more) if (more.hasOwnProperty(key)) r[key] = more[key];
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
