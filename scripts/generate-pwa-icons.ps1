# Gera os ícones da PWA (aplicativo instalável) a partir da logo, com o System.Drawing do próprio Windows — sem
# instalar nada. Uso, na raiz do projeto:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/generate-pwa-icons.ps1 -Origem public/img/logo.png
#
# Saída em public/icons/ (referenciada por public/manifest.json e public/index.html):
#   icon-192.png, icon-512.png      ícones "any": a logo ocupando quase todo o quadrado, fundo branco
#   icon-maskable-512.png           "maskable": a logo dentro da zona segura (80% central). O Android recorta o ícone em
#                                   círculo ou gota; sem a margem, as pontas da logo seriam cortadas
#   apple-touch-icon.png            180 px, fundo branco opaco (o iOS pinta de preto o que for transparente)
#   favicon-32.png                  aba do navegador
#
# A logo é recortada às bordas do desenho (ignora margem branca ou transparente da imagem original) antes de
# centralizar, para todos os tamanhos terem a mesma proporção visual.

param(
  [Parameter(Mandatory = $true)][string]$Origem,
  [string]$Destino = 'public/icons',
  [string]$Fundo = '#FFFFFF'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$origemCompleta = (Resolve-Path -LiteralPath $Origem).Path
$fonte = [System.Drawing.Bitmap]::FromFile($origemCompleta)
try {
  # Recorte às bordas do desenho: pixel "vazio" = transparente ou quase branco.
  $minX = $fonte.Width; $minY = $fonte.Height; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $fonte.Height; $y += 2) {
    for ($x = 0; $x -lt $fonte.Width; $x += 2) {
      $c = $fonte.GetPixel($x, $y)
      $vazio = ($c.A -lt 16) -or ($c.R -gt 245 -and $c.G -gt 245 -and $c.B -gt 245)
      if (-not $vazio) {
        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  if ($maxX -lt 0) { throw 'A imagem parece vazia (toda branca ou transparente).' }
  $recorte = New-Object System.Drawing.Rectangle($minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1))

  $pasta = Join-Path (Get-Location) $Destino
  New-Item -ItemType Directory -Force -Path $pasta | Out-Null
  $corFundo = [System.Drawing.ColorTranslator]::FromHtml($Fundo)

  function Gerar([string]$nome, [int]$tamanho, [double]$ocupacao) {
    $bmp = New-Object System.Drawing.Bitmap($tamanho, $tamanho, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $g.Clear($corFundo)
      # Maior lado da logo = $ocupacao do quadrado, mantendo a proporção, centralizada.
      $escala = ($tamanho * $ocupacao) / [Math]::Max($recorte.Width, $recorte.Height)
      $w = [int][Math]::Round($recorte.Width * $escala); $h = [int][Math]::Round($recorte.Height * $escala)
      $alvo = New-Object System.Drawing.Rectangle([int](($tamanho - $w) / 2), [int](($tamanho - $h) / 2), $w, $h)
      $atributos = New-Object System.Drawing.Imaging.ImageAttributes
      $atributos.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY) # sem borda escura no redimensionamento
      $g.DrawImage($fonte, $alvo, $recorte.X, $recorte.Y, $recorte.Width, $recorte.Height, [System.Drawing.GraphicsUnit]::Pixel, $atributos)
      $caminho = Join-Path $pasta $nome
      $bmp.Save($caminho, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Output ("  {0,-24} {1,4} px  ({2:N1} KB)" -f $nome, $tamanho, ((Get-Item $caminho).Length / 1KB))
    } finally {
      $g.Dispose(); $bmp.Dispose()
    }
  }

  Write-Output "Ícones gerados em $Destino a partir de $Origem (logo recortada: $($recorte.Width) x $($recorte.Height) px):"
  Gerar 'icon-192.png' 192 0.86
  Gerar 'icon-512.png' 512 0.86
  # 0.66: os pontos extremos da logo ficam a até 39% do centro, dentro do círculo seguro de 40% (testado em 18/10/2026).
  Gerar 'icon-maskable-512.png' 512 0.66
  Gerar 'apple-touch-icon.png' 180 0.80
  Gerar 'favicon-32.png' 32 0.94
} finally {
  $fonte.Dispose()
}
