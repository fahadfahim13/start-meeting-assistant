/**
 * String externalization (plan §8.10). Deliberately dependency-free: a typed
 * dictionary in the same nested shape as i18next resources, so adopting the
 * library later is a mechanical swap. Adding Bangla = translating `en` into a
 * `bn` object of the same type and switching on a setting.
 *
 * Rule: no user-facing static string lives in a component. Dynamic values are
 * interpolated by the caller.
 */

export const en = {
  app: {
    title: 'MeetFroge',
    tabRecord: 'Record',
    tabLibrary: 'Library',
    tabSettings: 'Settings',
    rec: '● REC',
    paused: '⏸ PAUSED',
  },
  setup: {
    heading: 'Sources',
    meetingTitle: 'Meeting title',
    meetingTitlePlaceholder: 'Weekly sync',
    screen: 'Screen / window',
    camera: 'Camera',
    microphone: 'Microphone',
    none: 'None',
    virtualSuffix: ' (virtual)',
    unavailableSuffix: ' — unavailable to recorder',
    systemAudio: 'Capture system audio (what you hear)',
    cameraEnabled: 'Record camera',
    microphoneEnabled: 'Record microphone',
    sourceOffHint: 'Turning a source off keeps the device selected, so switching it back on restores it.',
    quality: 'Quality',
    qualityEfficient: 'Efficient — 720p10, smallest files',
    qualityBalanced: 'Balanced — 1080p15 (recommended)',
    qualityHigh: 'High — 1080p30',
    qualityArchival: 'Archival — native, largest files',
    refreshDevices: 'Refresh devices',
    screenOption: (n: number) => `Screen ${n}`,
  },
  preview: {
    heading: 'Preview',
    screenLabel: 'This screen/window will be recorded — the transcript, visual analysis and summary all come from it.',
    noScreen: 'No screen selected — only the camera/audio will be recorded.',
    sourceGone: 'That window has been closed. Refresh devices and pick another source.',
    sourceMinimized: 'That window is minimised, so there is nothing to capture. Restore it before recording.',
    previewFailed: 'Preview unavailable right now — the source may be busy. Recording is unaffected.',
    mic: 'Mic',
    system: 'System',
    cameraOff: 'Camera off — no camera track will be recorded.',
    micOff: 'Microphone off — your own voice will not be recorded.',
    systemOff: 'System audio off — other people in the call will not be recorded.',
    systemCheckHint:
      'Play something from the meeting now — this bar should move. If it stays flat, Windows is sending the sound to a different output device than the one being captured, and the other people will not be recorded.',
    systemSilent: 'No system audio is arriving. Check your Windows output device.',
    deviceUnavailable: (label: string) =>
      `"${label}" is switched on but the recorder cannot address it, so it will produce no track. Pick a different device.`,
    estimate: (perHour: string, free: string) => `≈ ${perHour}/hour · ${free} free`,
  },
  controls: {
    checkSetup: 'Check setup',
    record: '● Record',
    pause: '⏸ Pause',
    resume: '▶ Resume',
    stop: '■ Stop',
    dropWarning: (n: number) => `⚠ ${n} audio frames dropped`,
    muteMic: 'Mute mic',
    unmuteMic: 'Unmute mic',
    muteSystem: 'Mute system',
    unmuteSystem: 'Unmute system',
    mutedNote: 'Muted tracks stay in the file as silence, so the recording joins up correctly.',
    recordingIssues: 'About the recording you just made',
    dismiss: 'Dismiss',
  },
  library: {
    meetings: 'Meetings',
    sourcePrefix: 'Source: ',
    searchAll: 'Search all meetings (speech + on-screen text)',
    searchAllAria: 'Search all meetings, speech and on-screen text',
    searchTranscript: 'Search this transcript…',
    searchTranscriptAria: 'Search within this transcript',
    noRecordings: 'No recordings yet. Record one from the Record tab.',
    noMatches: 'No matches.',
    recovered: ' recovered',
    transcribe: 'transcribe',
    reprocess: 'Re-process',
    processing: 'Processing…',
    retryJob: 'retry',
    /**
     * Why a step did not produce anything, in a sentence the user can act on.
     * Never render the raw code: "PIPELINE_NO_SPEECH" tells a user nothing, and
     * a skip with no explanation is exactly what made a finished pipeline look
     * like a stuck one.
     */
    jobReason: (code: string): string =>
      ({
        PIPELINE_NO_AUDIO: 'No audio was recorded, so there was nothing to transcribe.',
        PIPELINE_AUDIO_SILENT:
          'Every audio track captured silence. Check that the right microphone was selected and that sound was playing on your default output device.',
        PIPELINE_NO_SPEECH:
          'Sound was captured, but no speech could be recognised in it — the recording was too quiet.',
        PIPELINE_NO_TRANSCRIPT: 'There is no transcript, so there was nothing to summarise.',
        PIPELINE_NO_VIDEO: 'This recording has no screen track to analyse.',
        PIPELINE_MODEL_MISSING:
          'The model this step needs has not been downloaded yet — see Settings.',
        PIPELINE_WORKDIR_MISSING:
          'The intermediate audio was already cleaned up. Press Re-process to redo it.',
        PIPELINE_STAGE_FAILED: 'This step failed after several attempts.',
      })[code] ?? 'This step did not run.',
    tags: 'tags',
    tagsPrompt: 'Tags (comma-separated):',
    delete: 'delete',
    deleteConfirm: (title: string, size: string) =>
      `Delete "${title}" and its recording (${size})? This cannot be undone.`,
    viewSummary: 'Summary',
    viewTranscript: 'Transcript',
    viewQa: 'Q&A',
    qaEmpty: 'No Q&A report yet.',
    qaExplain:
      'A Q&A report turns this meeting into the questions a colleague who missed it would ask, each answered from what was actually said.',
    qaGenerate: 'Generate Q&A',
    qaRegenerate: 'Regenerate Q&A',
    qaRunning: 'Generating…',
    qaNeedsTranscript: 'A transcript is needed first — there is nothing to build questions from.',
    qaDegraded:
      '⚠ The model pass failed validation, so this was assembled from the stored summary.',
    qaGeneratedAt: (when: string) => `Generated ${when}`,
    selectMeeting: 'Select a meeting to view its transcript.',
    noTranscript: 'No transcript for this meeting.',
    noSummary: 'No summary for this meeting.',
    degradedSummary: '⚠ Structured summarization failed — showing merged raw notes.',
    keyPoints: 'Key points',
    decisions: 'Decisions',
    actionItems: 'Action items',
    openQuestions: 'Open questions',
    regenerate: 'Regenerate',
    renamePrompt: (name: string) => `Rename "${name}" to:`,
    speakerCertain: 'Identified from your microphone track (exact)',
    speakerDiarized: 'Diarized (probabilistic) — click to rename',
    jumpTo: 'Jump to this moment',
    exportCancelled: 'Export cancelled',
    exportSaved: (file: string) => `Saved ${file}`,
    playerAria:
      'Meeting recording playback. Shortcuts: space or K play-pause, J and L or arrows seek five seconds, up and down arrows change speed.',
    screenHit: 'SCREEN',
    speechHit: 'SPEECH',
  },
  settings: {
    loading: 'Loading…',
    recording: 'Recording',
    defaultQuality: 'Default quality',
    autoProcess: 'Process automatically when a recording stops',
    sidecarFiles: 'Save transcript, summary and Q&A next to the recording',
    recordingsFolder: 'Recordings folder:',
    changeFolder: 'Change…',
    useDefaultFolder: 'Use default',
    folderNote:
      'New recordings are saved here, along with their transcript, summary and Q&A files. Recordings you already have stay where they are.',
    folderUnwritable:
      '⚠ This folder is not writable right now — recording is blocked until it is reachable again.',
    folderChanged: (p: string) => `New recordings will be saved to ${p}`,
    folderReset: 'Back to the default folder.',
    transcription: 'Transcription',
    language: 'Language',
    langEn: 'English (Bangla words transliterated — recommended for mixed speech)',
    langBn: 'Bangla',
    langAuto: 'Auto-detect (can flip mid-sentence on mixed speech)',
    banglishHint:
      'Mixed Bangla-English speech is the hardest case for every open model — accuracy is lower at language switch points. Transcripts are editable.',
    visual: 'Visual analysis',
    keyframeSensitivity: 'Keyframe sensitivity',
    kfSensitive: 'Sensitive — more keyframes, catches subtle changes',
    kfBalanced: 'Balanced (recommended)',
    kfSparse: 'Sparse — fewer keyframes, faster processing',
    models: 'Models',
    modelReady: '✓ ready',
    modelMissing: 'missing',
    modelCorrupt: '⚠ corrupt/partial',
    modelsHint:
      'Missing models make their pipeline stage skip (the rest still runs). The guided download flow arrives with the installer.',
    modelsFolder: 'Models folder:',
    saved: 'Saved',
  },
} as const

export type Strings = typeof en

/** The active dictionary. A `bn: Strings` translation switches here. */
export const t: Strings = en
