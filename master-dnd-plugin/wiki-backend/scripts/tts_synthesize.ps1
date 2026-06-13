param (
    [string]$textFilePath,
    [string]$wavFilePath,
    [string]$play = "false"
)

try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    
    # Legge il testo da file con codifica UTF-8
    $text = Get-Content -Path $textFilePath -Raw -Encoding utf8
    
    # Sintetizza nel file WAV
    $synth.SetOutputToWaveFile($wavFilePath)
    $synth.Speak($text)
    $synth.Dispose()
    
    # Riproduce l'audio in locale se richiesto
    if ($play -eq "true" -or $play -eq "1") {
        $player = New-Object System.Media.SoundPlayer
        $player.SoundLocation = $wavFilePath
        $player.PlaySync()
    }
    
    Write-Output "success"
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
