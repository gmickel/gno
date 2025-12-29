# GNO Hero Demo

Output "hero.gif"

Set Theme "TokyoNight"
Set FontFamily "Menlo"
Set FontSize 16
Set Width 1000
Set Height 700
Set Padding 20
Set TypingSpeed 30ms
Set CursorBlink false

# Polish
Set WindowBar Colorful
Set BorderRadius 8
Set Margin 20
Set MarginFill "#0f1419"
Set LoopOffset 25%
Set PlaybackSpeed 1.2

Sleep 500ms

Type "gno search 'authentication JWT'"
Sleep 300ms
Enter
Sleep 4000ms

Type "gno query 'security best practices' --limit 3"
Sleep 300ms
Enter
Sleep 4000ms

Type "gno ask 'how do I authenticate with JWT tokens?' --answer --limit 3"
Enter
Sleep 15000ms
