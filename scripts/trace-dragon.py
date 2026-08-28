"""Regenerate web/src/dragonArt.ts from assets/dragon/*.png.

    python3 scripts/trace-dragon.py assets/dragon/calm.png out.svg

Only needed if the drawings change — the traced paths are committed.

Trace the dragon line art into SVG paths.

Marching squares at the 0.5 alpha crossing (the source is antialiased, so the
crossing is sub-pixel), segments chained into closed loops, then
Douglas-Peucker to drop the points that were only describing the grid.
Holes come out as their own loops and are handled by fill-rule evenodd.
"""
import struct, sys, zlib
from collections import deque, defaultdict


def read_png(path):
    d = open(path, "rb").read()
    i, idat = 8, b""
    while i < len(d):
        ln = struct.unpack(">I", d[i:i+4])[0]; typ = d[i+4:i+8]
        if typ == b"IHDR": w, h = struct.unpack(">II", d[i+8:i+16])
        elif typ == b"IDAT": idat += d[i+8:i+8+ln]
        i += 12 + ln
    raw = zlib.decompress(idat); stride = w*4
    out = bytearray(); p = 0
    for _ in range(h):
        f = raw[p]; p += 1
        assert f == 0, f
        out += raw[p:p+stride]; p += stride
    return w, h, [out[i*4+3] for i in range(w*h)]


def marching(alpha, w, h, thr=128.0):
    """Closed loops along the thr crossing, in pixel coordinates."""
    def A(x, y):
        if x < 0 or y < 0 or x >= w or y >= h: return 0.0
        return float(alpha[y*w + x])

    def interp(p, q, va, vb):
        if vb == va: return ((p[0]+q[0])/2, (p[1]+q[1])/2)
        t = (thr - va) / (vb - va)
        return (p[0] + (q[0]-p[0])*t, p[1] + (q[1]-p[1])*t)

    segs = []
    # sample on pixel centres; the grid runs one cell past each edge so shapes
    # touching the border still close
    for y in range(-1, h):
        for x in range(-1, w):
            tl, tr = A(x, y), A(x+1, y)
            bl, br = A(x, y+1), A(x+1, y+1)
            idx = (1 if tl >= thr else 0) | (2 if tr >= thr else 0) | (4 if br >= thr else 0) | (8 if bl >= thr else 0)
            if idx in (0, 15): continue
            P = (x+0.5, y+0.5); Q = (x+1.5, y+0.5); R = (x+1.5, y+1.5); S = (x+0.5, y+1.5)
            top = interp(P, Q, tl, tr); right = interp(Q, R, tr, br)
            bottom = interp(S, R, bl, br); left = interp(P, S, tl, bl)
            table = {
                1: [(left, top)], 2: [(top, right)], 3: [(left, right)],
                4: [(right, bottom)], 6: [(top, bottom)], 7: [(left, bottom)],
                8: [(bottom, left)], 9: [(bottom, top)], 11: [(bottom, right)],
                12: [(right, left)], 13: [(right, top)], 14: [(top, left)],
                5: [(left, top), (right, bottom)], 10: [(top, right), (bottom, left)],
            }
            segs.extend(table[idx])

    # chain segments end-to-start into loops
    starts = defaultdict(list)
    K = lambda p: (round(p[0], 4), round(p[1], 4))
    for a, b in segs: starts[K(a)].append((a, b))
    loops = []
    used = set()
    for i, (a0, b0) in enumerate(segs):
        if i in used: continue
        # walk forward
        loop = [a0]; cur = b0; used.add(i)
        for _ in range(len(segs) + 5):
            loop.append(cur)
            nxt = None
            for cand in starts.get(K(cur), []):
                j = segs.index(cand)
                if j not in used:
                    nxt = cand; used.add(j); break
            if nxt is None: break
            cur = nxt[1]
            if K(cur) == K(a0): break
        if len(loop) >= 3: loops.append(loop)
    return loops


def dp(points, eps):
    """Douglas-Peucker on a closed ring."""
    if len(points) < 3: return points
    def rec(pts):
        if len(pts) < 3: return pts
        a, b = pts[0], pts[-1]
        dx, dy = b[0]-a[0], b[1]-a[1]
        n = (dx*dx + dy*dy) ** 0.5
        worst, wi = -1, 0
        for i in range(1, len(pts)-1):
            p = pts[i]
            d = abs(dy*p[0] - dx*p[1] + b[0]*a[1] - b[1]*a[0]) / n if n else ((p[0]-a[0])**2 + (p[1]-a[1])**2) ** 0.5
            if d > worst: worst, wi = d, i
        if worst > eps:
            return rec(pts[:wi+1])[:-1] + rec(pts[wi:])
        return [a, b]
    return rec(points)


def to_path(loops, eps):
    out = []
    for loop in loops:
        pts = dp(loop, eps)
        if len(pts) < 3: continue
        d = f"M{pts[0][0]:.2f} {pts[0][1]:.2f}"
        for p in pts[1:-1]: d += f"L{p[0]:.2f} {p[1]:.2f}"
        out.append(d + "Z")
    return "".join(out)


def build(src_outline, src_solid, out_svg, eps=0.45):
    w, h, outline = read_png(src_outline)
    _, _, solid = read_png(src_solid)

    # a stroke pixel is "contour" when the exterior is within reach of it;
    # the rest is interior detail (belly stripes, the eye, the wing ribs)
    outside = [1 if solid[i] < 128 else 0 for i in range(w*h)]
    dist = [10**6]*(w*h)
    q = deque()
    for i, o in enumerate(outside):
        if o: dist[i] = 0; q.append(i)
    while q:
        i = q.popleft(); x, y = i % w, i // w
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            nx, ny = x+dx, y+dy
            if 0 <= nx < w and 0 <= ny < h:
                j = ny*w + nx
                if dist[j] > dist[i] + 1:
                    dist[j] = dist[i] + 1; q.append(j)
    REACH = 4
    detail = [outline[i] if dist[i] > REACH else 0 for i in range(w*h)]

    paths = {
        "body": to_path(marching(solid, w, h), eps),
        "stroke": to_path(marching(outline, w, h), eps),
        "detail": to_path(marching(detail, w, h), eps),
    }
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">'
        + "".join(f'<path id="{k}" fill-rule="evenodd" d="{v}"/>' for k, v in paths.items())
        + "</svg>"
    )
    open(out_svg, "w").write(svg)
    print(f"{out_svg}: " + " ".join(f"{k}={len(v)}B" for k, v in paths.items()))


build(sys.argv[1], sys.argv[2], sys.argv[3], eps=0.8)
