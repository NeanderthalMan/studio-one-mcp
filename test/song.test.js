import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { readSong, summarizeSong } from '../src/song.js';

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
      <MediaTrack mediaType="Audio" name="Vox" color="FFFFC693" activeLayer="1" timeFormat="2">
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

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 's1mcp-'));
  const path = join(dir, 'Fixture Song.song');
  writeFileSync(path, zipSync({
    'metainfo.xml': strToU8(metaXml),
    'Song/song.xml': strToU8(songXml),
    'Song/mediapool.xml': strToU8(mediaXml),
    'Devices/audiomixer.xml': strToU8(mixerXml),
    'Devices/transportdevice.xml': strToU8('<TransportDevice position="20" loopStart="0" loopEnd="4" loopActive="1"/>'),
  }));
  return path;
}

test('tempo, time signature and metadata', () => {
  const s = readSong(fixture());
  assert.equal(s.title, 'Fixture Song');
  assert.deepEqual(s.tempo.map((t) => t.bpm), [120, 60]);
  assert.deepEqual(s.timeSignatures.map((t) => t.signature), ['4/4', '3/4']);
  assert.equal(s.key, null);
});

test('markers convert beats to bars and seconds', () => {
  const s = readSong(fixture());
  assert.deepEqual(s.markers.map((m) => [m.name, m.bar, m.beat, m.seconds]), [
    ['Start', 1, 1, 0],
    ['Chorus', 5, 1, 8],
  ]);
});

test('takes: active layer drives track events; positions cross tempo and meter changes', () => {
  const [vox] = readSong(fixture()).tracks;
  assert.equal(vox.name, 'Vox');
  assert.deepEqual(vox.layers.map((l) => [l.name, l.active]), [['Vox Take 1', false], ['Vox Take 2', true]]);
  const [ev] = vox.events;
  assert.equal(ev.name, 'take2');
  // beat 34 = 32 beats at 0.5s (16s) + 2 beats at 1s → 18s; bar 9 is at beat 32 so this is bar 9 beat 3.
  assert.deepEqual([ev.start.bar, ev.start.beat, ev.start.seconds, ev.lengthSeconds], [9, 3, 18, 3]);
  assert.equal(ev.file, '/tmp/Media/Vox 2.wav');
  assert.equal(vox.layers[0].events[0].file, '/tmp/Media/Vox 1.wav', 'file URLs are decoded');
});

test('mixer: dB, pan, mute, inserts without rack state entries', () => {
  const s = readSong(fixture());
  const vox = s.mixer.find((c) => c.label === 'Vox');
  assert.equal(vox.volumeDb, -6.02);
  assert.equal(vox.pan, -0.5);
  assert.equal(vox.mute, true);
  assert.deepEqual(vox.inserts.map((i) => i.name), ['Pro EQ']);
  assert.equal(s.tracks[0].mixer.output, 'Main');
});

test('transport positions are seconds', () => {
  const { transport } = readSong(fixture());
  assert.deepEqual([transport.position.seconds, transport.position.beats, transport.position.bar], [20, 36, 10]);
  assert.equal(transport.loop.end.beats, 8);
  assert.equal(transport.loop.active, true);
});

test('summary is compact', () => {
  const sum = summarizeSong(readSong(fixture()));
  assert.deepEqual(sum.tracks, [{ name: 'Vox', type: 'Audio', events: 1, takes: 2, activeTake: 'Vox Take 2', volumeDb: -6.02, mute: true, solo: undefined, inserts: ['Pro EQ'] }]);
  assert.deepEqual(sum.markers, ['Start @ bar 1', 'Chorus @ bar 5']);
});
