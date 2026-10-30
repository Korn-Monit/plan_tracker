Add-Type -AssemblyName System.Drawing

$size = 256
$bitmap = [System.Drawing.Bitmap]::new($size, $size)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$backgroundPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
$backgroundPath.AddArc(8, 8, 48, 48, 180, 90)
$backgroundPath.AddArc(200, 8, 48, 48, 270, 90)
$backgroundPath.AddArc(200, 200, 48, 48, 0, 90)
$backgroundPath.AddArc(8, 200, 48, 48, 90, 90)
$backgroundPath.CloseFigure()
$backgroundBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.Point]::new(24, 24),
    [System.Drawing.Point]::new(232, 232),
    [System.Drawing.ColorTranslator]::FromHtml('#6750E8'),
    [System.Drawing.ColorTranslator]::FromHtml('#2979D8')
)
$graphics.FillPath($backgroundBrush, $backgroundPath)

$white = [System.Drawing.Color]::FromArgb(245, 255, 255, 255)
$pen = [System.Drawing.Pen]::new($white, 15)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawArc($pen, 55, 55, 146, 146, -62, 302)
$graphics.DrawLine($pen, 59, 61, 58, 105)
$graphics.DrawLine($pen, 58, 105, 101, 103)
$graphics.DrawLine($pen, 128, 84, 128, 133)
$graphics.DrawLine($pen, 128, 133, 164, 154)

$outputPath = Join-Path $PSScriptRoot '..\resources\plan-tracker.png'
$bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$pen.Dispose()
$backgroundBrush.Dispose()
$backgroundPath.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output "Generated $outputPath"
