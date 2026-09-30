// More operations for the MCP Track Edit task (included by McpTrackEdit.js):
// track order, instrument tracks, plug-ins and FX sends, events, arranger
// sections, markers and time signatures. Each op is mtoOps[name](context, op)
// and returns the fields of its result; failures are { error }.
//
// Seen on Studio One 5.5.2 (probed 2026-09-30):
//  - functions.root.createIterator() walks every track in song order, the global
//    Marker Track and Arranger Track first; their events are the markers and the
//    arranger sections, with names, live.
//  - Event times (start, length, offset) are numbers in the event's own
//    timeFormat (0 seconds, 1 samples, 2 quarter-note beats); a MediaTime from
//    functions.newMediaTime() converts: set .seconds, read .as(format).
//  - moveToFolder(root, track) takes a track out of a folder and puts it right
//    after that folder (its index argument is ignored at the root, and a track
//    already at the root does not move). So a track is reordered by moving it
//    into a temporary folder made at the target place, out again, and removing
//    the folder.
//  - DeviceEditFunctions.insertDevice(folder, classID) adds a plug-in to an
//    Inserts folder (undoable), an instrument to the Synths folder (undoable), or
//    an effect to a channel's Sends folder, which makes an FX channel with it and
//    a send there (that one did not come off with one undo).
//  - Everything one run of the task does is one undo step.
//  - A JavaScript error in here (a null member access) pops a modal Scripting
//    Error dialog even under try/catch, so every lookup is checked.

var mtoOps = {};

function mtoFn(obj, key) { return !!obj && typeof obj[key] === "function"; }

// Every track, global ones included, in song order.
function mtoAllTracks(context) {
	var out = [];
	var root = context.functions ? context.functions.root : null;
	if (!mtoFn(root, "createIterator")) return out;
	var it = root.createIterator();
	while (it && mtoFn(it, "done") && !it.done()) {
		var t = it.next();
		if (!t) break;
		out.push(t);
	}
	return out;
}

function mtoTrack(context, name) {
	var all = mtoAllTracks(context), hit = null, n = 0;
	for (var i = 0; i < all.length; i++) if (all[i].name === name) { hit = all[i]; n++; }
	if (n !== 1) return { error: n ? "track name is ambiguous: " + name : "no track named " + name };
	return { track: hit };
}

function mtoGlobalTrack(context, name) {
	var all = mtoAllTracks(context);
	for (var i = 0; i < all.length; i++) if (all[i].name === name && mtoFn(all[i], "createIterator")) return all[i];
	return null;
}

function mtoEventStart(ev) { return ev && ev.startTime && typeof ev.startTime.seconds === "number" ? ev.startTime.seconds : 0; }

// A track's events in time order.
function mtoEvents(track) {
	var out = [];
	if (!mtoFn(track, "createIterator")) return out;
	var it = track.createIterator(), ev;
	while (it && mtoFn(it, "next") && (ev = it.next())) out.push(ev);
	out.sort(function (a, b) { return mtoEventStart(a) - mtoEventStart(b); });
	return out;
}

function mtoRound(x) { return typeof x === "number" ? Math.round(x * 1000) / 1000 : null; }

function mtoSeconds(time) { return time && typeof time.seconds === "number" ? mtoRound(time.seconds) : null; }

// A MediaTime at `seconds`, or null.
function mtoTime(context, seconds) {
	var f = context.functions;
	if (!mtoFn(f, "newMediaTime") || typeof seconds !== "number" || seconds < 0) return null;
	var t = f.newMediaTime();
	if (!t) return null;
	t.seconds = seconds;
	return t;
}

// `seconds` as a number in an event's own time format, or null.
function mtoIn(context, seconds, format) {
	var t = mtoTime(context, seconds);
	return t && mtoFn(t, "as") ? t.as(typeof format === "number" ? format : 0) : null;
}

// op.event: 1-based number in time order, or an event name (first match).
function mtoPickEvent(list, which, what) {
	if (typeof which === "number") {
		if (which < 1 || which > list.length) return { error: what + " " + which + " does not exist (there are " + list.length + ")" };
		return { event: list[which - 1], number: which };
	}
	if (typeof which === "string") {
		for (var i = 0; i < list.length; i++) if (list[i].name === which) return { event: list[i], number: i + 1 };
		return { error: "no " + what + " named " + which };
	}
	return { error: what + " is required (number or name)" };
}

function mtoLevelDb(ev) {
	var vc = ev ? ev.volumeCurve : null;
	if (!vc || typeof vc.level !== "number" || vc.level <= 0) return null;
	return Math.round(2000 * Math.log(vc.level) / Math.LN10) / 100;
}

function mtoEventInfo(ev, number) {
	var vc = ev.volumeCurve;
	var start = mtoSeconds(ev.startTime), end = mtoSeconds(ev.endTime);
	var out = { number: number, name: typeof ev.name === "string" ? ev.name : "", start: start, end: end, length: start !== null && end !== null ? mtoRound(end - start) : null, muted: !!ev.isMuted };
	if (vc && typeof vc.level === "number") {
		out.gainDb = mtoLevelDb(ev);
		out.fadeIn = mtoRound(vc.fadeInLength);
		out.fadeOut = mtoRound(vc.fadeOutLength);
	}
	return out;
}

// ---- plug-ins by name (same list as the bridge's live_plugins) -------------------

function mtoPluginClass(name, category) {
	if (!Host.Classes || !mtoFn(Host.Classes, "createInstance")) return { error: "the plug-in list is not available" };
	var menu = Host.Classes.createInstance("Host:PlugInMenuParam");
	if (!menu || !mtoFn(menu, "setCategory") || !mtoFn(menu, "setValue") || !mtoFn(menu, "getSelectedClass")) return { error: "the plug-in list is not available" };
	menu.setCategory(category);
	var exact = -1, loose = -1, want = String(name || "");
	for (var i = menu.min; i <= menu.max; i++) {
		menu.setValue(i, true);
		var n = String(menu.string);
		if (n === want && exact < 0) exact = i;
		if (n.toLowerCase() === want.toLowerCase() && loose < 0) loose = i;
	}
	var at = exact >= 0 ? exact : loose;
	if (at < 0) return { error: "no " + (category === "AudioSynth" ? "instrument" : "plug-in") + " named " + want };
	menu.setValue(at, true);
	return { cls: menu.getSelectedClass(), name: String(menu.string) };
}

function mtoChannel(context, label) {
	var root = context.functions ? context.functions.root : null;
	var env = root ? root.environment : null;
	var con = mtoFn(env, "find") ? env.find("MixerConsole") : null;
	if (!mtoFn(con, "getChannelList")) return { error: "the mixer console is not available" };
	var list = con.getChannelList(1);
	if (!list || !mtoFn(list, "getChannel")) return { error: "the mixer console is not available" };
	var hit = null, n = 0;
	for (var i = 0; i < list.numChannels; i++) {
		var c = list.getChannel(i);
		if (c && c.label === label) { hit = c; n++; }
	}
	if (n !== 1) return { error: n ? "channel name is ambiguous: " + label : "no channel named " + label };
	return { channel: hit };
}

function mtoDeviceFunctions(context) {
	var root = context.functions ? context.functions.root : null;
	var dev = mtoFn(root, "createFunctions") ? root.createFunctions("DeviceEditFunctions") : null;
	return mtoFn(dev, "insertDevice") ? dev : null;
}

// { channel, plugin, folder: "Inserts" | "Sends" }
function mtoInsertInto(context, op, folderName) {
	var p = mtoPluginClass(op.plugin, "AudioEffect");
	if (p.error) return p;
	var c = mtoChannel(context, op.channel);
	if (c.error) return c;
	var folder = mtoFn(c.channel, "find") ? c.channel.find(folderName) : null;
	if (!folder) return { error: op.channel + " has no " + folderName.toLowerCase() + " to add to" };
	var dev = mtoDeviceFunctions(context);
	if (!dev) return { error: "insertDevice is not available" };
	var slot = dev.insertDevice(folder, p.cls);
	if (!slot) return { error: "Studio One did not add " + p.name };
	return { channel: op.channel, added: p.name };
}

mtoOps.addPlugin = function (context, op) { return mtoInsertInto(context, op, "Inserts"); };
mtoOps.addFxSend = function (context, op) { return mtoInsertInto(context, op, "Sends"); };

// { name, instrument }: an instrument track playing a new instance of the instrument.
mtoOps.addInstrumentTrack = function (context, op) {
	var f = context.functions;
	var root = f ? f.root : null;
	if (!mtoFn(f, "addMediaTrack") || !root) return { error: "addMediaTrack is not available" };
	var p = mtoPluginClass(op.instrument, "AudioSynth");
	if (p.error) return p;
	var fmt = Host.Engine && Host.Engine.TrackFormats && mtoFn(Host.Engine.TrackFormats, "findEqual") ? Host.Engine.TrackFormats.findEqual("Instrument") : null;
	var synths = root.environment && mtoFn(root.environment, "find") ? root.environment.find("Synths") : null;
	var parts = mtoFn(root, "createFunctions") ? root.createFunctions("MusicPartFunctions") : null;
	var dev = mtoDeviceFunctions(context);
	if (!fmt || !synths || !dev || !mtoFn(parts, "connectTrackWithInstrument")) return { error: "instrument tracks cannot be made here" };
	var tl = context.mainTrackList;
	var at = tl && mtoFn(tl, "getInsertPosition") ? tl.getInsertPosition() : -1;
	f.executeImmediately = true;
	var track = f.addMediaTrack(at, String(op.name || p.name), fmt);
	var slot = track ? dev.insertDevice(synths, p.cls) : null;
	var connected = slot ? parts.connectTrackWithInstrument(track, slot, 0, false) : 0;
	f.executeImmediately = false;
	if (!track) return { error: "Studio One did not add the track" };
	if (!slot) return { error: "the track was added but " + p.name + " was not", track: String(track.name) };
	return { track: String(track.name), instrument: p.name, connected: !!connected, channel: track.channel && typeof track.channel.label === "string" ? track.channel.label : null };
};

// ---- track order ------------------------------------------------------------------

// { track, before | after }: both at the song's top level (not inside a folder).
mtoOps.moveTrack = function (context, op) {
	var f = context.functions;
	var root = f ? f.root : null;
	if (!mtoFn(f, "moveToFolder") || !mtoFn(f, "addTrack") || !mtoFn(f, "removeTrack") || !root) return { error: "moving tracks is not available" };
	var t = mtoTrack(context, op.track);
	if (t.error) return t;
	var refName = typeof op.before === "string" ? op.before : op.after;
	if (typeof refName !== "string") return { error: "moveTrack needs before or after (a track name)" };
	var ref = mtoTrack(context, refName);
	if (ref.error) return ref;
	if (ref.track === t.track) return { error: "a track cannot move next to itself" };
	if (t.track.parentFolderID || ref.track.parentFolderID) return { error: "only tracks at the top level (not inside a folder) can be reordered" };
	var all = mtoAllTracks(context);
	var at = all.indexOf(ref.track);
	if (at < 0) return { error: "no track named " + refName };
	f.executeImmediately = true;
	if (mtoFn(f, "beginMultiple")) f.beginMultiple("Move Track");
	var tmp = f.addTrack("FolderTrack", typeof op.before === "string" ? at : at + 1, "mcp-move");
	var ok = false;
	if (tmp) {
		f.moveToFolder(tmp, t.track);
		f.moveToFolder(root, t.track);
		f.removeTrack(tmp);
		ok = true;
	}
	if (mtoFn(f, "endMultiple")) f.endMultiple(false);
	f.executeImmediately = false;
	if (!ok) return { error: "Studio One did not make the temporary folder" };
	var order = [];
	var after = mtoAllTracks(context);
	for (var i = 0; i < after.length; i++) if (after[i].mediaType || after[i].isFolder) order.push(String(after[i].name));
	return { track: op.track, order: order };
};

// ---- events -------------------------------------------------------------------------

mtoOps.events = function (context, op) {
	var t = mtoTrack(context, op.track);
	if (t.error) return t;
	var list = mtoEvents(t.track), out = [];
	for (var i = 0; i < list.length; i++) out.push(mtoEventInfo(list[i], i + 1));
	return { track: op.track, events: out };
};

// { track, event, to?, toTrack?, gainDb?, addGainDb?, fadeIn?, fadeOut? }: edits in that order.
mtoOps.editEvent = function (context, op) {
	var f = context.functions;
	var root = f ? f.root : null;
	var t = mtoTrack(context, op.track);
	if (t.error) return t;
	var pick = mtoPickEvent(mtoEvents(t.track), op.event, "event");
	if (pick.error) return pick;
	var ev = pick.event;
	var before = mtoEventInfo(ev, pick.number);
	var done = [];
	f.executeImmediately = true;
	if (typeof op.to === "number") {
		var pos = mtoIn(context, op.to, ev.timeFormat);
		if (pos === null || !mtoFn(f, "moveEvent")) { f.executeImmediately = false; return { error: "cannot move to " + op.to }; }
		f.moveEvent(ev, pos);
		done.push("move");
	}
	var audio = null;
	var wantsAudio = typeof op.gainDb === "number" || typeof op.addGainDb === "number" || typeof op.fadeIn === "number" || typeof op.fadeOut === "number";
	if (wantsAudio) {
		audio = mtoFn(root, "createFunctions") ? root.createFunctions("AudioFunctions") : null;
		if (!ev.volumeCurve || !mtoFn(audio, "modifyVolume")) { f.executeImmediately = false; return { error: "gain and fades are for audio events" }; }
		audio.executeImmediately = true;
		var delta = typeof op.addGainDb === "number" ? op.addGainDb : (typeof op.gainDb === "number" ? op.gainDb - (mtoLevelDb(ev) || 0) : 0);
		if (delta) { audio.modifyVolume(ev, delta); done.push("gain"); }
		if (typeof op.fadeIn === "number" && mtoFn(audio, "createFadeIn")) { audio.createFadeIn(ev, ev.volumeCurve.fadeInType || 0, Math.max(0, op.fadeIn), ev.volumeCurve.fadeInBend || 0); done.push("fadeIn"); }
		if (typeof op.fadeOut === "number" && mtoFn(audio, "createFadeOut")) { audio.createFadeOut(ev, ev.volumeCurve.fadeOutType || 0, Math.max(0, op.fadeOut), ev.volumeCurve.fadeOutBend || 0); done.push("fadeOut"); }
		audio.executeImmediately = false;
	}
	if (typeof op.toTrack === "string") {
		var dst = mtoTrack(context, op.toTrack);
		if (dst.error) { f.executeImmediately = false; return dst; }
		if (!mtoFn(f, "transferEvent")) { f.executeImmediately = false; return { error: "transferEvent is not available" }; }
		f.transferEvent(ev, dst.track);
		done.push("toTrack");
	}
	f.executeImmediately = false;
	return { track: op.track, before: before, after: mtoEventInfo(ev, pick.number), done: done };
};

// { track, event }: select just that event, so Edit/Duplicate, Copy and Paste act on it.
mtoOps.selectEvent = function (context, op) {
	var f = context.functions, e = context.editor;
	var t = mtoTrack(context, op.track);
	if (t.error) return t;
	var pick = mtoPickEvent(mtoEvents(t.track), op.event, "event");
	if (pick.error) return pick;
	var sf = mtoFn(e, "createSelectFunctions") ? e.createSelectFunctions(f) : null;
	if (!mtoFn(sf, "select")) return { error: "selecting events is not available" };
	sf.selectExclusive = true;
	sf.select(pick.event);
	return { selected: mtoEventInfo(pick.event, pick.number) };
};

// { track }: make it the focus track, where Edit/Paste puts the clipboard (the
// track selection alone does not: pasting then made a new track).
mtoOps.focusTrack = function (context, op) {
	var t = mtoTrack(context, op.track);
	if (t.error) return t;
	if (!context.editor || !mtoFn(context.editor, "setFocusItem")) return { error: "the editor cannot focus a track" };
	context.editor.setFocusItem(t.track);
	return { focused: op.track };
};

// ---- arranger sections --------------------------------------------------------------

function mtoArranger(context) {
	var m = context.editor ? context.editor.model : null;
	var arr = m ? m.arranger : null;
	var track = mtoFn(arr, "getArrangerTrack") ? arr.getArrangerTrack() : null;
	return track ? { arranger: arr, track: track } : { error: "the arranger track is not available" };
}

function mtoSectionInfo(ev, number) {
	var start = mtoSeconds(ev.startTime), end = mtoSeconds(ev.endTime);
	return { number: number, name: typeof ev.name === "string" ? ev.name : "", start: start, end: end, length: start !== null && end !== null ? mtoRound(end - start) : null };
}

mtoOps.sections = function (context) {
	var a = mtoArranger(context);
	if (a.error) return a;
	var list = mtoEvents(a.track), out = [];
	for (var i = 0; i < list.length; i++) out.push(mtoSectionInfo(list[i], i + 1));
	return { sections: out };
};

// { start, end, name } in seconds. The new section shows up after the task returns.
mtoOps.addSection = function (context, op) {
	var f = context.functions;
	var a = mtoArranger(context);
	if (a.error) return a;
	var s = mtoTime(context, op.start), e = mtoTime(context, op.end);
	if (!s || !e || !(op.end > op.start)) return { error: "addSection needs start < end (seconds)" };
	if (!mtoFn(a.arranger, "addArrangerEvent")) return { error: "addArrangerEvent is not available" };
	f.executeImmediately = true;
	var ev = a.arranger.addArrangerEvent(a.track, s, e);
	if (ev && typeof op.name === "string" && op.name && mtoFn(f, "renameEvent")) f.renameEvent(ev, op.name);
	f.executeImmediately = false;
	if (!ev) return { error: "Studio One did not add the section" };
	return { added: typeof ev.name === "string" ? ev.name : "", start: op.start, end: op.end };
};

// { section (number or name), name?, start?, end? } (seconds; start moves, end resizes), or remove.
mtoOps.editSection = function (context, op) {
	var f = context.functions;
	var a = mtoArranger(context);
	if (a.error) return a;
	var pick = mtoPickEvent(mtoEvents(a.track), op.section, "section");
	if (pick.error) return pick;
	var ev = pick.event;
	var before = mtoSectionInfo(ev, pick.number);
	f.executeImmediately = true;
	if (op.remove) {
		var gone = mtoFn(f, "removeEvent") ? f.removeEvent(ev) : 0;
		f.executeImmediately = false;
		return gone ? { removed: before } : { error: "Studio One did not remove the section" };
	}
	if (typeof op.name === "string" && op.name && mtoFn(f, "renameEvent")) f.renameEvent(ev, op.name);
	if (typeof op.end === "number" && mtoFn(f, "resizeEvent")) {
		var endAt = mtoIn(context, op.end, ev.timeFormat);
		if (endAt === null || endAt <= ev.start) { f.executeImmediately = false; return { error: "end must be after the section's start" }; }
		f.resizeEvent(ev, ev.start, ev.offset, endAt - ev.start);
	}
	if (typeof op.start === "number" && mtoFn(f, "moveEvent")) {
		var startAt = mtoIn(context, op.start, ev.timeFormat);
		if (startAt === null) { f.executeImmediately = false; return { error: "cannot move to " + op.start }; }
		f.moveEvent(ev, startAt);
	}
	f.executeImmediately = false;
	return { before: before, after: mtoSectionInfo(ev, pick.number) };
};

// { section }: select just that section. Edit/Copy then takes the section with
// everything under it on every track, and Edit/Paste inserts it at the playhead
// (checked on 5.5.2); Edit/Delete and Cut take only the section itself.
mtoOps.selectSection = function (context, op) {
	var f = context.functions, e = context.editor;
	var a = mtoArranger(context);
	if (a.error) return a;
	var pick = mtoPickEvent(mtoEvents(a.track), op.section, "section");
	if (pick.error) return pick;
	var sf = mtoFn(e, "createSelectFunctions") ? e.createSelectFunctions(f) : null;
	if (!mtoFn(sf, "select")) return { error: "selecting sections is not available" };
	sf.selectExclusive = true;
	sf.select(pick.event);
	return { selected: mtoSectionInfo(pick.event, pick.number) };
};

// ---- markers and time signatures ----------------------------------------------------

function mtoMarkerInfo(ev, number) {
	var kinds = { 0: "marker", 2: "start", 3: "end" };
	return { number: number, name: typeof ev.name === "string" ? ev.name : "", seconds: mtoSeconds(ev.startTime), kind: kinds[ev.markerType] || "marker" };
}

mtoOps.markers = function (context) {
	var mt = mtoGlobalTrack(context, "Marker Track");
	if (!mt) return { error: "the marker track is not available" };
	var list = mtoEvents(mt), out = [];
	for (var i = 0; i < list.length; i++) out.push(mtoMarkerInfo(list[i], i + 1));
	return { markers: out };
};

// { marker: number (as live_markers numbers them) or name, name }
mtoOps.renameMarker = function (context, op) {
	var f = context.functions;
	var mt = mtoGlobalTrack(context, "Marker Track");
	if (!mt) return { error: "the marker track is not available" };
	var pick = mtoPickEvent(mtoEvents(mt), op.marker, "marker");
	if (pick.error) return pick;
	if (typeof op.name !== "string" || !op.name) return { error: "renameMarker needs name" };
	if (!mtoFn(f, "renameEvent")) return { error: "renameEvent is not available" };
	var before = mtoMarkerInfo(pick.event, pick.number);
	f.renameEvent(pick.event, op.name);
	return { before: before, name: op.name };
};

// { at: [seconds] }: the time signature in effect at each position.
mtoOps.signatures = function (context, op) {
	var mt = mtoGlobalTrack(context, "Marker Track");
	var first = mt ? mtoEvents(mt)[0] : null;
	var tc = first ? first.timeContext : null;
	if (!mtoFn(tc, "getTimeSignature")) return { error: "the time signature map is not available" };
	var at = op.at && typeof op.at.length === "number" ? op.at : [0];
	var out = [];
	for (var i = 0; i < at.length; i++) {
		var t = mtoTime(context, at[i]);
		var sig = t ? tc.getTimeSignature(t.musical) : null;
		out.push({ seconds: at[i], beat: t ? mtoRound(t.musical) : null, numerator: sig ? sig.numerator : null, denominator: sig ? sig.denominator : null });
	}
	return { signatures: out };
};
