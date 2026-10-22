$ErrorActionPreference = 'Stop'
$taskVoiceRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$taskVoiceSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $taskVoiceSynth.SelectVoice('Microsoft Huihui Desktop')
    $taskVoiceSynth.Rate = 0
    $taskVoiceSynth.Volume = 100
    $taskVoiceFormat = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(8000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $taskVoiceSynth.SetOutputToWaveFile($taskVoiceRequest.path, $taskVoiceFormat)
    $taskVoiceSynth.Speak([string]$taskVoiceRequest.text)
} finally {
    $taskVoiceSynth.Dispose()
}
[Console]::WriteLine('{"engine":"Microsoft Huihui Desktop","sample_rate":8000,"channels":1}')
