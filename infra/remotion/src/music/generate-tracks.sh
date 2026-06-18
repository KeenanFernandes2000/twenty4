#!/usr/bin/env bash
# generate-tracks.sh — Deterministically synthesize the bundled placeholder music.
#
# These are SYNTHESIZED test tracks (NOT licensed music): a sustained tonal bed
# plus a percussive kick on every beat at an exact BPM. Because the kick lands on
# a mathematically exact grid, the beat grid in tracks.ts is exact and the montage
# cuts land perfectly on the beat — ideal for the render de-risk gate.
#
# TODO(music): replace each synthesized track with a licensed/CC0 track and
# recompute its beat grid with essentia.js (RhythmExtractor2013).
#
# Requires FFMPEG_PATH (static ffmpeg). Run: bash generate-tracks.sh
# Output: ../../public/music/*.mp3  (44.1kHz stereo, ~36s each)
set -euo pipefail

FFMPEG="${FFMPEG_PATH:-ffmpeg}"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../public/music" && pwd)"
DUR=36          # seconds (>= 30s montage + headroom for audio startMs offset)
SR=44100

# synth_track <file> <bpm> <bed_hz> <kick_start_hz> <bed_gain>
# Builds a tonal bed (sine) + a per-beat kick (exponentially-decaying low sine
# pitch-swept down) and mixes them. Beat period = 60/bpm seconds.
synth_track() {
  local file="$1" bpm="$2" bed_hz="$3" kick_hz="$4" bed_gain="$5"
  local period beats
  period=$(awk "BEGIN{printf \"%.6f\", 60.0/$bpm}")
  # one click loops every `period` seconds; aevalsrc builds an exp-decaying kick.
  # mod(t,period) gives time-since-last-beat; kick = sin sweep * exp decay.
  "$FFMPEG" -hide_banner -loglevel error -y \
    -f lavfi -i "sine=frequency=${bed_hz}:sample_rate=${SR}:duration=${DUR}" \
    -f lavfi -i "sine=frequency=$(awk "BEGIN{print $bed_hz*1.5}"):sample_rate=${SR}:duration=${DUR}" \
    -f lavfi -i "aevalsrc='(0.9*exp(-28*mod(t\,${period})))*sin(2*PI*(${kick_hz}*exp(-9*mod(t\,${period})))*mod(t\,${period}))':s=${SR}:d=${DUR}" \
    -filter_complex "\
      [0:a]volume=${bed_gain}[bed1];\
      [1:a]volume=$(awk "BEGIN{print $bed_gain*0.4}")[bed2];\
      [2:a]volume=1.0[kick];\
      [bed1][bed2][kick]amix=inputs=3:normalize=0,\
      acompressor=threshold=0.5:ratio=4:attack=5:release=120,\
      alimiter=limit=0.95,\
      aformat=sample_fmts=fltp:channel_layouts=stereo[out]" \
    -map "[out]" -ac 2 -ar "${SR}" -c:a libmp3lame -b:a 192k \
    "${OUT_DIR}/${file}"
  echo "  wrote ${file}  (bpm=${bpm}, ${DUR}s)"
}

echo "Synthesizing bundled placeholder tracks → ${OUT_DIR}"
# musicId               file                 bpm  bedHz  kickHz  bedGain
synth_track "chill_90.mp3"      90  220 110 0.10   # Chill / Mellow — 90 BPM, A3 bed
synth_track "house_120.mp3"    120  165  90 0.12   # Party / Travel — 120 BPM, E3 bed
synth_track "fastcut_128.mp3"  128  330 100 0.10   # Fast Cut — 128 BPM, E4 bed
synth_track "clean_100.mp3"    100  262  95 0.11   # Clean / Soft — 100 BPM, C4 bed
echo "Done."
