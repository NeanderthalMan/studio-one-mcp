// studio-one-mcp edit task ("Musical Functions/MCP Edit").
//
// Studio One hands an edit task the notes of the selected parts (context.iterator)
// and the editing functions its own Musical Functions use (context.functions).
// The bridge writes the operations to mailbox/edit-request.json, selects a
// track's parts, runs this task's command, and reads mailbox/edit-result.json.
// prepareEdit asks for no dialog, so none opens.
//
// Times are numbers in the notes' own time format (quarter-note beats, as
// note.startTime.time reads). Nothing here may throw or call an unchecked host
// member: in Studio One that pops a modal Scripting Error dialog.
include_file("McpEditConfig.js");

function mcpUrl(name) {
	return Host.Url(McpEditConfig.mailbox + name);
}

function mcpRead(name) {
	if (!Host.IO.File(mcpUrl(name)).exists()) return null;
	var f = Host.IO.openTextFile(mcpUrl(name), "utf-8");
	if (!f) return null;
	var text = f.readLine();
	f.close();
	if (typeof text !== "string" || !text) return null;
	var value = null;
	try { value = JSON.parse(text.replace(/^﻿/, "")); } catch (_) { value = null; }
	return value;
}

function mcpWrite(name, value) {
	var f = Host.IO.createTextFile(mcpUrl(name), "utf-8");
	if (!f) return;
	f.writeString(JSON.stringify(value) + "\n");
	f.close();
}

function mcpHas(obj, key) {
	return !!obj && typeof obj[key] === "function";
}

function mcpClamp(v, lo, hi) {
	return Math.max(lo, Math.min(hi, v));
}

function mcpStart(note) {
	return note.startTime && typeof note.startTime.time === "number" ? note.startTime.time : null;
}

function mcpLength(note) {
	var s = mcpStart(note);
	return s !== null && note.endTime && typeof note.endTime.time === "number" ? note.endTime.time - s : null;
}

// filter: { pitch, pitches: [], from, to } (beats; from inclusive, to exclusive)
function mcpMatch(note, filter) {
	if (!filter) return true;
	if (typeof filter.pitch === "number" && note.pitch !== filter.pitch) return false;
	if (filter.pitches && filter.pitches.indexOf && filter.pitches.indexOf(note.pitch) < 0) return false;
	var s = mcpStart(note);
	if (typeof filter.from === "number" && (s === null || s < filter.from - 1e-6)) return false;
	if (typeof filter.to === "number" && (s === null || s >= filter.to - 1e-6)) return false;
	return true;
}

function mcpApply(context, ops) {
	var fns = context.functions;
	var notes = [];
	var it = context.iterator;
	while (it && mcpHas(it, "done") && !it.done()) {
		var n = it.next();
		if (!n) break;
		notes.push(n);
	}
	var applied = [];
	var errors = [];
	if (!fns) return { applied: applied, errors: ["no editing functions"], notesBefore: notes.length };
	for (var i = 0; i < ops.length; i++) {
		var op = ops[i] || {};
		var count = 0;
		var hit = [];
		for (var k = 0; k < notes.length; k++) if (mcpMatch(notes[k], op.filter)) hit.push(notes[k]);
		switch (op.op) {
			case "transpose":
				if (typeof op.semitones !== "number" || !mcpHas(fns, "modifyPitch")) { errors.push("transpose needs semitones"); break; }
				for (var a = 0; a < hit.length; a++) { fns.modifyPitch(hit[a], mcpClamp(hit[a].pitch + op.semitones, 0, 127)); count++; }
				break;
			case "velocity":
				if (!mcpHas(fns, "modifyVelocity")) { errors.push("velocity not available"); break; }
				for (var b = 0; b < hit.length; b++) {
					var v = typeof op.set === "number" ? op.set : (typeof op.add === "number" ? Math.round(hit[b].velocity * 127) + op.add : null);
					if (v === null) { errors.push("velocity needs set or add"); break; }
					fns.modifyVelocity(hit[b], mcpClamp(v, 1, 127) / 127);
					count++;
				}
				break;
			case "move":
				if (typeof op.beats !== "number" || !mcpHas(fns, "moveEvent")) { errors.push("move needs beats"); break; }
				for (var c = 0; c < hit.length; c++) { var s0 = mcpStart(hit[c]); if (s0 === null) continue; fns.moveEvent(hit[c], Math.max(0, s0 + op.beats)); count++; }
				break;
			case "length":
				if (!mcpHas(fns, "resizeEvent")) { errors.push("length not available"); break; }
				for (var d = 0; d < hit.length; d++) {
					var len = mcpLength(hit[d]);
					var nl = typeof op.set === "number" ? op.set : (typeof op.scale === "number" && len !== null ? len * op.scale : null);
					if (nl === null || nl <= 0) { errors.push("length needs set or scale (> 0)"); break; }
					fns.resizeEvent(hit[d], nl);
					count++;
				}
				break;
			case "delete":
				if (!op.filter) { errors.push("delete needs a filter (refusing to delete every note)"); break; }
				if (!mcpHas(fns, "deleteEvent")) { errors.push("delete not available"); break; }
				for (var e = 0; e < hit.length; e++) { fns.deleteEvent(hit[e]); count++; }
				break;
			case "add":
				var region = notes.length && notes[0].region ? notes[0].region : context.activeRegion;
				if (!region || !mcpHas(fns, "createEvent") || !mcpHas(fns, "insertEvent")) { errors.push("add: no part to add to"); break; }
				var list = op.notes && op.notes.length ? op.notes : [];
				fns.executeImmediately = true;
				for (var f = 0; f < list.length; f++) {
					var spec = list[f];
					if (typeof spec.pitch !== "number" || typeof spec.beat !== "number" || typeof spec.length !== "number" || spec.length <= 0) { errors.push("add: each note needs pitch, beat, length"); continue; }
					var note = fns.createEvent("Note");
					if (!note) { errors.push("add: could not create a note"); break; }
					fns.insertEvent(region, note);
					fns.modifyPitch(note, mcpClamp(spec.pitch, 0, 127));
					fns.modifyVelocity(note, mcpClamp(typeof spec.velocity === "number" ? spec.velocity : 100, 1, 127) / 127);
					if (mcpHas(fns, "freezeVelocity")) fns.freezeVelocity(note);
					fns.resizeEvent(note, spec.length);
					fns.moveEvent(note, spec.beat);
					count++;
				}
				break;
			default:
				errors.push("unknown op " + op.op);
		}
		applied.push({ op: op.op, notes: count });
	}
	return { applied: applied, errors: errors, notesBefore: notes.length };
}

function McpEditTask() {
	this.interfaces = [Host.Interfaces.IEditTask];

	this.prepareEdit = function (context) {
		return Host.Results.kResultOk;
	};

	this.performEdit = function (context) {
		var req = mcpRead("edit-request.json");
		if (!req || !req.id || !req.ops || typeof req.ops.length !== "number") {
			mcpWrite("edit-result.json", { id: req && req.id ? req.id : null, error: "no edit request" });
			return Host.Results.kResultOk;
		}
		var r = mcpApply(context, req.ops);
		r.id = req.id;
		mcpWrite("edit-result.json", r);
		return Host.Results.kResultOk;
	};
}

function createMcpEdit() {
	return new McpEditTask();
}
