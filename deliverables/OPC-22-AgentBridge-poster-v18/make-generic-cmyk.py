from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageCms
from reportlab.lib.units import mm
from reportlab.pdfgen.canvas import Canvas


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit(
            "Usage: make-generic-cmyk.py <rgb-jpeg> <cmyk-jpeg> <cmyk-pdf> <cmyk-profile>"
        )

    rgb_path = Path(sys.argv[1]).resolve()
    cmyk_jpeg_path = Path(sys.argv[2]).resolve()
    cmyk_pdf_path = Path(sys.argv[3]).resolve()
    cmyk_profile_path = Path(sys.argv[4]).resolve()

    Image.MAX_IMAGE_PIXELS = None
    srgb_profile = ImageCms.createProfile("sRGB")
    cmyk_profile = ImageCms.getOpenProfile(str(cmyk_profile_path))
    transform = ImageCms.buildTransformFromOpenProfiles(
        srgb_profile,
        cmyk_profile,
        "RGB",
        "CMYK",
        renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
    )

    with Image.open(rgb_path) as source:
        source.draft("RGB", source.size)
        rgb = source.convert("RGB")
        cmyk = ImageCms.applyTransform(rgb, transform)
        cmyk.save(
            cmyk_jpeg_path,
            "JPEG",
            quality=92,
            subsampling=0,
            dpi=(300, 300),
            icc_profile=cmyk_profile.tobytes(),
        )
        cmyk.close()
        rgb.close()

    canvas = Canvas(
        str(cmyk_pdf_path),
        pagesize=(1200 * mm, 2000 * mm),
        pageCompression=1,
        invariant=1,
    )
    canvas.setTitle("OPC 22 AgentBridge - Generic CMYK proof")
    canvas.setSubject("Agfa SWOP Standard generic CMYK backup; not printer-specific PDF/X")
    canvas.drawImage(
        str(cmyk_jpeg_path),
        0,
        0,
        width=1200 * mm,
        height=2000 * mm,
        preserveAspectRatio=False,
        anchor="c",
    )
    canvas.showPage()
    canvas.save()


if __name__ == "__main__":
    main()
