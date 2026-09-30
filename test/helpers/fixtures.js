// A synthetic .song in the shape Studio One 5.5.2 writes, for tests. (The repo
// is public, so no real songs are checked in.)
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8 } from 'fflate';

// A minimal song in the shape Studio One 5.5 writes: 120 bpm for 8 bars of 4/4,
// then 60 bpm and 3/4 from beat 32 (bar 9).
const songXml = `﻿<?xml version="1.0" encoding="UTF-8"?>
<Song>
  <Attributes x:id="Root" defaultTimeFormat="2" length="316">
    <Attributes x:id="timeContext" sampleRate="44100">
      <TempoMap x:id="tempoMap">
        <TempoMapSegment curveType="0" start="0" end="32" tempo="0.5"/>
        <TempoMapSegment curveType="0" start="32" end="1e200" tempo="1"/>
      </TempoMap>
      <TimeSignatureMap x:id="timeSignatureMap">
        <TimeSignatureMapSegment start="0" numerator="4" denominator="4"/>
        <TimeSignatureMapSegment start="32" numerator="3" denominator="4"/>
      </TimeSignatureMap>
    </Attributes>
    <List x:id="Tracks">
      <MarkerTrack name="Marker">
        <MarkerEvent markerType="2" timeFormat="2" name="Start"/>
        <MarkerEvent start="16" timeFormat="2" name="Chorus"/>
      </MarkerTrack>
      <MediaTrack mediaType="Audio" name="Vox" trackID="{TR-VOX}" color="FFFFC693" activeLayer="1" timeFormat="2">
        <SpeakerSetup x:id="trackFormat" type="Mono"/>
        <UID x:id="channelID" uid="{CH-VOX}"/>
        <List x:id="Layers">
          <Attributes id="0" layerName="Vox Take 1">
            <List x:id="Events">
              <AudioEvent clipID="{CLIP-1}" timeFormat="2" start="4" length="8" name="take1"/>
            </List>
          </Attributes>
          <Attributes id="1" layerName="Vox Take 2">
            <List x:id="Events">
              <AudioEvent clipID="{CLIP-2}" timeFormat="2" start="34" length="3" name="take2"/>
            </List>
          </Attributes>
        </List>
      </MediaTrack>
      <ArrangerTrack timeFormat="2"><Attributes x:id="attributes" hidden="1"/></ArrangerTrack>
    </List>
  </Attributes>
</Song>`;

const mediaXml = `<MediaPool><Attributes x:id="rootFolder"><MediaFolder name="Audio">
  <AudioClip mediaID="{CLIP-1}"><Url x:id="path" type="1" url="file:///tmp/Media/Vox%201.wav"/>
    <Attributes x:id="format" frameCount="176400" sampleRate="44100" numChannels="1" bitDepth="24"/></AudioClip>
  <AudioClip mediaID="{CLIP-2}"><Url x:id="path" type="1" url="file:///tmp/Media/Vox 2.wav"/>
    <Attributes x:id="format" frameCount="132300" sampleRate="44100" numChannels="1" bitDepth="24"/></AudioClip>
</MediaFolder></Attributes></MediaPool>`;

const mixerXml = `<AudioMixer><Attributes x:id="channels">
  <ChannelGroup name="AudioTrack">
    <AudioTrackChannel gain="0.5" pan="0.25" label="Vox" mute="1" solo="0">
      <UID x:id="uniqueID" uid="{CH-VOX}"/>
      <Connection x:id="destination" friendlyName="Main"/>
      <Attributes x:id="Inserts">
        <Attributes name="FX01">
          <Attributes x:id="deviceData" name="Pro EQ"/>
          <Attributes x:id="ghostData"><Attributes x:id="classInfo" name="Pro EQ" subCategory="(Native)/EQ"/></Attributes>
        </Attributes>
        <Attributes x:id="Presets" pname="default"/>
        <Attributes x:id="Combinator" name="Combinator"/>
      </Attributes>
    </AudioTrackChannel>
  </ChannelGroup>
  <ChannelGroup name="AudioOutput"><AudioOutputChannel gain="1" pan="0.5" label="Main"/></ChannelGroup>
</Attributes></AudioMixer>`;

const metaXml = `<MetaInformation>
  <Attribute id="Document:Title" value="Fixture Song"/>
  <Attribute id="Document:Generator" value="Studio One/5.5.2.86528"/>
  <Attribute id="Media:Length" value="120"/>
  <Attribute id="Media:KeySignature" value="-"/>
</MetaInformation>`;

// UBJSON as Studio One writes it in Performances/*.musicx and Envelopes/*.envelopex:
// objects, arrays, int8/int32 and float64, keys as int8-length strings.
export function encodeUbjson(v) {
  const parts = [];
  const push = (...bytes) => parts.push(Buffer.from(bytes));
  const key = (k) => { const s = Buffer.from(k, 'utf8'); push(0x69, s.length); parts.push(s); };
  const val = (x) => {
    if (x === null) return push(0x5a);
    if (typeof x === 'boolean') return push(x ? 0x54 : 0x46);
    if (Number.isInteger(x) && x >= -128 && x <= 127) return push(0x69, x & 0xff);
    if (Number.isInteger(x)) { const b = Buffer.alloc(5); b[0] = 0x6c; b.writeInt32BE(x, 1); return parts.push(b); }
    if (typeof x === 'number') { const b = Buffer.alloc(9); b[0] = 0x44; b.writeDoubleBE(x, 1); return parts.push(b); }
    if (Array.isArray(x)) { push(0x5b); x.forEach(val); return push(0x5d); }
    push(0x7b);
    for (const [k, y] of Object.entries(x)) { key(k); val(y); }
    return push(0x7d);
  };
  val(v);
  return new Uint8Array(Buffer.concat(parts));
}

// Extras (opt-in so the base fixture's expectations stay put): an instrument
// track "Keys" whose part shows clip beats 4..12 at song beat 4, a saved Pro EQ
// state for the Vox insert, Vox in automation Read, and a Vox volume envelope.
const keysTrack = `
      <MediaTrack mediaType="Music" name="Keys" trackID="{TR-KEYS}" timeFormat="2">
        <List x:id="Layers"><Attributes id="0" layerName="Keys.1"><List x:id="Events">
          <MusicPart clipID="{CLIP-M}" timeFormat="2" start="4" length="8" offset="4" name="Keys"/>
        </List></Attributes></List>
      </MediaTrack>`;
const keysClip = `<MediaFolder name="Music"><MusicClip mediaID="{CLIP-M}" name="Keys">
  <Url x:id="dataPath" type="1" url="media:///Performances/Keys/Keys(0).musicx"/></MusicClip></MediaFolder>`;
export const KEYS_NOTES = [
  { start: 4.5, pitch: 60, noteId: 1, length: 0.5, velocity: 0.8 },
  { start: 6, pitch: 64, noteId: 2, length: 1, velocity: 1 },
  { start: 12.5, pitch: 67, noteId: 3, length: 0.5, velocity: 0.5 }, // after the part's end: hidden
];

export function writeSong(path, { title = 'Fixture Song', extras = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const files = {
    'metainfo.xml': strToU8(metaXml.replace('Fixture Song', title)),
    'Song/song.xml': strToU8(extras ? songXml.replace('<ArrangerTrack', `${keysTrack}\n      <ArrangerTrack`) : songXml),
    'Song/mediapool.xml': strToU8(extras ? mediaXml.replace('</MediaFolder></Attributes>', `</MediaFolder>${keysClip}</Attributes>`) : mediaXml),
    'Devices/audiomixer.xml': strToU8(extras
      ? mixerXml
        .replace('<Attributes x:id="deviceData" name="Pro EQ"/>', '<Attributes x:id="deviceData" name="Pro EQ"/><String x:id="presetPath" text="Presets/Channels/Vox/1 - Pro EQ.fxpreset"/>')
        .replace('<Connection x:id="destination" friendlyName="Main"/>', '<Connection x:id="destination" friendlyName="Main"/><Attributes x:id="Automation" mode="1"/>')
      : mixerXml),
    'Devices/transportdevice.xml': strToU8('<TransportDevice position="20" loopStart="0" loopEnd="4" loopActive="1"/>'),
  };
  if (extras) {
    files['Performances/Keys/Keys(0).musicx'] = encodeUbjson({ timeFormat: 2, events: KEYS_NOTES, envelopes: [] });
    files['Presets/Channels/Vox/1 - Pro EQ.fxpreset'] = strToU8('﻿<AudioEffectPreset><Attributes x:id="ParameterData" lffreq="40" lfgain="-3.5"/></AudioEffectPreset>');
    files['Envelopes/Vox/Volume.envelopex'] = encodeUbjson({ bipolar: 0, events: [{ time: 0, value: 0.5 }, { time: 8, value: 1 }] });
    files['Envelopes/Vox/Pan.envelopex'] = encodeUbjson({ bipolar: 1, events: [] });
    // Song notes and channel notes, as Studio One 5.5.2 lays them out (one item per channel).
    files['notes.txt'] = strToU8('﻿Verse 1: keep the breath before the chorus');
    files['notepad.xml'] = strToU8(`﻿<?xml version="1.0" encoding="UTF-8"?>
<NotepadData>
	<NotepadItem id="{1}" title="Vox" text="Take 2 is the keeper"/>
	<NotepadItem id="{2}" title="Main" text=""/>
</NotepadData>`);
  }
  writeFileSync(path, zipSync(files));
  return path;
}

export function fixture(opts = {}) {
  return writeSong(join(mkdtempSync(join(tmpdir(), 's1mcp-')), 'Fixture Song.song'), opts);
}

