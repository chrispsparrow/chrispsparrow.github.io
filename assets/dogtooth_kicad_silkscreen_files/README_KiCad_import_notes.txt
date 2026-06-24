DOGTOOTH SYSTEMS KiCad silkscreen artwork

Main KiCad import files are the *_kicad_black.svg files. SVG is the correct file type to use with KiCad PCB Editor -> File -> Import -> Graphics.
The white SVG/PNG files are included only as alternate/reversed previews. In KiCad, the selected PCB layer controls the actual silkscreen color.

Included variants:
1. 01_primary_full_logo_kicad_black.svg: 50 mm wide, about 29.6 mm tall. Best for a large open back-side or front-side branding area. Avoid shrinking below about 40 mm wide because the teeth and small fish details can get muddy.
2. 02_tail_based_logo_OLD_TAIL_kicad_black.svg: 35 mm wide, about 23.2 mm tall. This uses the OLD tail logo from the user-provided image, not the newly generated tail.
3. 03_compact_horizontal_lockup_kicad_black.svg: 45 mm wide, about 10.7 mm tall. Good for a long horizontal area near a board edge or unused open region.

KiCad import steps:
PCB Editor -> File -> Import -> Graphics -> choose the SVG -> select F.SilkS or B.SilkS -> place artwork -> scale only if needed.

PCB cautions:
Do not place over component pads, test pads, RF antenna keepouts, vias that need exposed metal, or solder mask openings. Keep SYSTEMS roughly 1.0 mm tall or larger after scaling for readable manufactured silkscreen.
