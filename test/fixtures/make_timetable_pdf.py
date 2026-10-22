"""Builds test/fixtures/timetable_sample.pdf: a small made-up timetable in the aSc
"Teacher wise" layout (one teacher per page, cell borders drawn as lines).
No real names. Run: python make_timetable_pdf.py"""
from reportlab.lib.pagesizes import landscape, A4
from reportlab.pdfgen import canvas

W, H = landscape(A4)
LEFT, DAYCOL, RIGHT = 12, 94, 830
TOP, HEAD_BOTTOM, BOTTOM = 60, 142, 566
DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa"]
COLW = (RIGHT - DAYCOL) / 8
ROWH = (BOTTOM - HEAD_BOTTOM) / 6
TIMES = ["9:30 - 10:20", "10:20 - 11:10", "11:10 - 12:00", "12:00 - 12:50",
         "12:50 - 1:40", "1:40 - 2:30", "2:30 - 3:20", "3:20 - 4:10"]

def y(top):  # top-down -> PDF
    return H - top

def line(c, x0, t0, x1, t1):
    c.line(x0, y(t0), x1, y(t1))

def page(c, teacher, cells):
    """cells: {(day, first_slot): (span, sub, course, venue, [class lines])}; sub = None | 0 | 1 (half rows)."""
    c.setFont("Helvetica", 22)
    c.drawCentredString(W / 2, y(40), f"Teacher {teacher}")
    c.setFont("Helvetica", 7)
    c.drawString(LEFT, y(56), "School of Engineering and Technology, Test University")
    c.setLineWidth(1)
    line(c, LEFT, TOP, RIGHT, TOP); line(c, LEFT, BOTTOM, RIGHT, BOTTOM)
    line(c, LEFT, TOP, LEFT, BOTTOM); line(c, RIGHT, TOP, RIGHT, BOTTOM)
    line(c, DAYCOL, TOP, DAYCOL, BOTTOM); line(c, LEFT, HEAD_BOTTOM, RIGHT, HEAD_BOTTOM)
    c.setLineWidth(0.5)
    for i in range(8):
        x = DAYCOL + i * COLW
        line(c, x + COLW, TOP, x + COLW, HEAD_BOTTOM)
        c.setFont("Helvetica", 20); c.drawCentredString(x + COLW / 2, y(100), str(i + 1))
        c.setFont("Helvetica", 7); c.drawCentredString(x + COLW / 2, y(135), TIMES[i])
    for d, day in enumerate(DAYS):
        t0 = HEAD_BOTTOM + d * ROWH
        t1 = t0 + ROWH
        line(c, LEFT, t1, DAYCOL, t1)
        c.setFont("Helvetica", 22); c.drawCentredString((LEFT + DAYCOL) / 2, y((t0 + t1) / 2 + 8), day)
        day_cells = [(s, span, sub) for (dd, s), (span, sub, *_r) in cells.items() if dd == day]
        mid = (t0 + t1) / 2
        for b in range(1, 9):  # line on the right of slot b
            xb = DAYCOL + b * COLW
            for half, (h0, h1) in ((0, (t0, mid)), (1, (mid, t1))):
                joined = any(s <= b < s + span - 1 and (sub is None or sub == half) for s, span, sub in day_cells)
                if not joined or b == 8:
                    line(c, xb, h0, xb, h1)
            line(c, xb - COLW, t1, xb, t1)
        for (dd, s), (span, sub, course, venue, cls) in cells.items():
            if dd != day:
                continue
            x0 = DAYCOL + (s - 1) * COLW
            x1 = x0 + span * COLW
            ct0, ct1 = (t0, t1) if sub is None else ((t0, (t0 + t1) / 2) if sub == 0 else ((t0 + t1) / 2, t1))
            if sub is not None:
                line(c, x0, (t0 + t1) / 2, x1, (t0 + t1) / 2)
            c.setFont("Helvetica", 6)
            c.drawString(x0 + 4, y(ct0 + 8), course)
            c.drawRightString(x1 - 4, y(ct0 + 8), venue)
            size, first, step = (14, 26, 14) if sub is None else (9, 17, 9)
            c.setFont("Helvetica", size)
            for i, txt in enumerate(cls):
                c.drawCentredString((x0 + x1) / 2, y(ct0 + first + i * step), txt)
    c.setFont("Helvetica", 7)
    c.drawString(LEFT, y(576), "Timetable generated:10-07-2026")
    c.showPage()

c = canvas.Canvas("timetable_sample.pdf", pagesize=landscape(A4))
page(c, "Ms Asha Verma", {
    ("Mo", 5): (1, None, "PA", "CVR303R", ["BE-CSE-5", "F"]),
    ("Mo", 7): (2, None, "PA", "CVR308R", ["BE-CSE-5G"]),
    ("We", 1): (2, None, "PA", "RJ309R", ["BE-CSE-5E"]),
})
page(c, "Mr Outside Person", {("Tu", 1): (1, None, "XYZ", "R1", ["BE-ME-3A"])})
page(c, "Dr. Ravi Kumar", {
    ("Tu", 1): (4, 0, "Bio chem P", "KLM102L", ["BP-2B", "Group 1"]),
    ("Tu", 2): (1, 1, "HDT-T", "KLM307R", ["BP-6A"]),
    ("Tu", 6): (1, 1, "HDT-T", "KLM307R", ["BP-6A"]),
    ("Th", 5): (4, None, "DSL", "CL02", ["BE-CSE-4C", "Group 2"]),
})
c.save()
