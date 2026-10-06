#!/usr/bin/env python3
"""Decodifica los QR de un PDF (primera página) o de una imagen SVG. Imprime uno por línea."""
import io, os, subprocess, sys, tempfile
from PIL import Image
from pyzbar.pyzbar import decode

path = sys.argv[1]
if path.lower().endswith(".svg"):
    import cairosvg
    img = Image.open(io.BytesIO(cairosvg.svg2png(url=path, output_width=700, background_color="white")))
else:
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(["pdftoppm", "-r", "200", "-png", "-f", "1", "-l", "1", path, os.path.join(d, "p")], check=True)
        img = Image.open(os.path.join(d, [f for f in os.listdir(d) if f.endswith(".png")][0])); img.load()
for r in decode(img):
    if r.type == "QRCODE":
        print(r.data.decode())
