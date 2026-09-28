"""Episode generator: goals, pages, and variants (loading, overlays, error pages)."""

from __future__ import annotations

import html
import random
from dataclasses import dataclass, field

from . import vocab
from .sites import PageSpec, TaskServer, Theme, _text

FAMILIES = ("click", "type", "scroll", "navigate", "back")
FAMILY_WEIGHTS = (0.3, 0.25, 0.17, 0.14, 0.14)

OVERLAYS = [
    ("bottom", "We use cookies to improve your experience.", ["Accept", "Accept all", "Got it", "OK"]),
    ("modal", "Subscribe to our newsletter for weekly updates!", ["No thanks", "Close", "×", "Maybe later"]),
    ("modal", "Your session is about to expire.", ["Dismiss", "Stay signed in", "OK"]),
    ("modal", "Something went wrong while loading recommendations.", ["Dismiss", "Close"]),
]


@dataclass
class Episode:
    episode_id: str
    family: str
    goal: str
    start: str
    setup_clicks: list[str] = field(default_factory=list)
    variants: list[str] = field(default_factory=list)
    max_steps: int = 10


def _button(key: str, label: str, link: bool = False) -> str:
    cls = "" if link else ' class="btn"'
    tag = "a" if link else "button"
    return f'<{tag}{cls} data-k="{key}">{html.escape(label)}</{tag}>'


def _labels(rng: random.Random, test: bool, n: int, avoid: set[str] = frozenset()) -> list[str]:
    pool = [x for x in vocab.split(vocab.BUTTONS, test) if x not in avoid]
    return rng.sample(pool, n)


def content_page(
    rng: random.Random, labels: list[str], theme: Theme, site: str, title: str
) -> tuple[str, dict[str, str]]:
    """Random layout containing clickable elements with the given labels; returns html and key->label."""
    keys = {f"e{i}": label for i, label in enumerate(labels)}
    items = list(keys.items())
    rng.shuffle(items)
    n_nav = rng.randint(0, min(4, len(items) - 1))
    nav, rest = items[:n_nav], items[n_nav:]
    header = (
        f'<header><span class="logo">{html.escape(site)}</span>{"".join(_button(k, v, True) for k, v in nav)}</header>'
    )
    layout = rng.choice(["cards", "sidebar", "rows", "hero"])
    cols = rng.randint(2, 4)
    if layout == "cards":
        cells = "".join(
            f'<div class="card"><h3>{html.escape(_text(rng, 2))}</h3><p class="muted">{_text(rng, rng.randint(6, 14))}</p>'
            f"{_button(k, v, rng.random() < 0.2)}</div>"
            for k, v in rest
        )
        body = f'<main><h1>{html.escape(title)}</h1><div class="grid" style="grid-template-columns:repeat({cols},1fr)">{cells}</div></main>'
    elif layout == "sidebar":
        side = rest[: len(rest) // 2]
        main = rest[len(rest) // 2 :]
        sb = "".join(f'<div style="margin:10px 0">{_button(k, v, rng.random() < 0.6)}</div>' for k, v in side)
        mn = "".join(f"<p>{_text(rng, rng.randint(8, 20))}</p><p>{_button(k, v)}</p>" for k, v in main)
        body = (
            f'<div style="display:flex"><aside style="width:{rng.randint(180, 260)}px;padding:20px;border-right:1px solid">{sb}</aside>'
            f"<main><h1>{html.escape(title)}</h1>{mn}</main></div>"
        )
    elif layout == "rows":
        rows = "".join(
            f'<div class="card" style="display:flex;align-items:center;justify-content:space-between;margin:10px 0">'
            f"<span>{html.escape(_text(rng, rng.randint(3, 7)))}</span>{_button(k, v, rng.random() < 0.25)}</div>"
            for k, v in rest
        )
        body = f"<main><h1>{html.escape(title)}</h1><p class=muted>{_text(rng, 12)}</p>{rows}</main>"
    else:
        hero, others = rest[:2], rest[2:]
        buttons = " ".join(_button(k, v) for k, v in hero)
        tail = "".join(f'<span style="margin-right:24px">{_button(k, v, True)}</span>' for k, v in others)
        body = (
            f'<main><div style="padding:{rng.randint(30, 90)}px 0;text-align:{rng.choice(["left", "center"])}">'
            f"<h1 style='font-size:2.4em'>{html.escape(title)}</h1><p class=muted>{_text(rng, 16)}</p>{buttons}</div>"
            f"<p>{tail}</p></main>"
        )
    return header + body, keys


def _overlay(rng: random.Random) -> tuple[str, dict]:
    kind, text, dismiss = rng.choice(OVERLAYS)
    label = rng.choice(dismiss)
    extra = f'<button class="btn" data-k="ov_x">{"Settings" if kind == "bottom" else "Learn more"}</button>'
    buttons = f'<button class="btn" data-k="ov_ok">{html.escape(label)}</button> '
    order = [buttons, extra] if rng.random() < 0.5 else [extra, buttons]
    html_ = f'<div id="overlay" class="{kind}"><div class="box"><p>{html.escape(text)}</p>{" ".join(order)}</div></div>'
    return html_, {"dismiss": "ov_ok"}


def make_episode(server: TaskServer, seed: int, test: bool, family: str | None = None) -> Episode:
    rng = random.Random(seed)
    family = family or rng.choices(FAMILIES, FAMILY_WEIGHTS)[0]
    ep = f"/p/{'t' if test else 'r'}{seed}"
    site = rng.choice(vocab.SITES)
    theme = Theme.sample(rng)
    variants: list[str] = []

    def runtime_variants(rt: dict, allow_overlay: bool = True) -> dict:
        if rng.random() < 0.2:
            rt["loadingStart"] = rng.randint(1200, 2500)
            variants.append("loading_start")
        if rng.random() < 0.3:
            rt["loadingAfter"] = rng.randint(1200, 2500)
            variants.append("loading_after")
        if allow_overlay and rng.random() < 0.25:
            rt["overlay_html"], rt["overlay"] = _overlay(rng)
            variants.append("overlay")
        return rt

    def maybe_error(spec: PageSpec) -> PageSpec:
        if rng.random() < 0.1:
            spec.error_first = True
            variants.append("error_page")
        return spec

    if family in ("click", "scroll"):
        labels = _labels(rng, test, rng.randint(4, 10))
        target = rng.randrange(len(labels))
        page_title = _text(rng, 2).rstrip(".")
        body, _ = content_page(rng, labels, theme, site, page_title)
        tkey = f"e{target}"
        rt = {"target": tkey, "confirm": {tkey: f"✓ {labels[target]} opened"}}
        if family == "scroll":
            filler = "".join(f"<p>{_text(rng, rng.randint(20, 40))}</p>" for _ in range(rng.randint(14, 26)))
            spot = f'<div style="margin:30px 28px">{_button(tkey + "s", labels[target])}</div>'
            body = body.replace(f'data-k="{tkey}"', f'data-k="{tkey}d"')
            up = rng.random() < 0.3
            body = (spot + body + f"<main>{filler}</main>") if up else (body + f"<main>{filler}</main>" + spot)
            rt = {"target": tkey + "s", "confirm": {tkey + "s": f"✓ {labels[target]} opened"}, "startAtBottom": up}
            variants.append("scroll_up" if up else "scroll_down")
        verb = rng.choice(['Click "{}"', 'Click the "{}" button', "Press {}", 'Tap on "{}"', "Open {}", 'Select "{}"'])
        goal = verb.format(labels[target])
        spec = maybe_error(PageSpec(family, page_title, body, theme, site, runtime_variants(rt)))
        server.pages[ep + "/a"] = spec
        return Episode(ep, family, goal, ep + "/a", variants=variants)

    if family == "type":
        names = rng.sample(vocab.split(vocab.FIELDS, test), rng.randint(2, 4))
        n_req = rng.randint(1, min(2, len(names)))
        values = rng.sample(vocab.split(vocab.VALUES, test), n_req)
        style = rng.choice(["above", "left", "placeholder"])
        fields_html = []
        for i, name in enumerate(names):
            ph = f' placeholder="{html.escape(name)}"' if style == "placeholder" else ""
            inp = f'<input data-k="f{i}"{ph}>'
            if style == "above":
                fields_html.append(f"<label>{html.escape(name)}</label>{inp}")
            elif style == "left":
                fields_html.append(
                    f'<div style="display:flex;align-items:center;margin:10px 0"><span style="width:160px">{html.escape(name)}</span>{inp}</div>'
                )
            else:
                fields_html.append(f'<div style="margin:12px 0">{inp}</div>')
        submit_label = rng.choice(["Submit", "Save", "Continue", "Send", "Apply", "Sign up", "Search", "Confirm"])
        submit = rng.random() < 0.5
        cancel = _button("cx", rng.choice(["Cancel", "Reset", "Back"]))
        form = (
            f'<div id="form" class="card" style="max-width:560px;margin:{rng.randint(10, 60)}px {rng.choice(["0", "auto"])}">'
            f"<h2>{html.escape(_text(rng, 2))}</h2>{''.join(fields_html)}<p>{_button('sb', submit_label)} {cancel}</p></div>"
        )
        head = f'<header><span class="logo">{html.escape(site)}</span></header>'
        body = head + f"<main>{form}</main>"
        req = [{"key": f"f{i}", "value": values[i]} for i in range(n_req)]
        decoys = [f"f{i}" for i in range(n_req, len(names))]
        parts = [
            rng.choice(
                ['Type "{v}" into the {n} field', 'Enter "{v}" as {n}', 'Fill {n} with "{v}"', 'Set {n} to "{v}"']
            ).format(v=values[i], n=names[i])
            for i in range(n_req)
        ]
        goal = " and ".join(parts)
        if submit:
            goal += rng.choice([', then press "{s}"', " and click {s}", ', then click "{s}"']).format(s=submit_label)
        rt = {"fields": req, "decoys": decoys, "submit": "sb" if submit else None, "confirm": {}}
        spec = maybe_error(PageSpec("type", "Form", body, theme, site, runtime_variants(rt)))
        server.pages[ep + "/a"] = spec
        return Episode(ep, "type", goal, ep + "/a", variants=variants)

    labels_a = _labels(rng, test, rng.randint(3, 8))
    title_a = _text(rng, 2).rstrip(".")
    body_a, keys_a = content_page(rng, labels_a, theme, site, title_a)
    labels_b = _labels(rng, test, rng.randint(3, 8))
    title_b = _text(rng, 2).rstrip(".")
    theme_b = theme if rng.random() < 0.6 else Theme.sample(rng)
    body_b, _ = content_page(rng, labels_b, theme_b, site, title_b)
    slug = "-".join(rng.sample(vocab.WORDS, 2))

    if family == "navigate":
        url = server.url(f"{ep}/{slug}")
        server.pages[ep + "/a"] = PageSpec(
            "navigate", title_a, body_a, theme, site, runtime_variants({"url": url, "confirm": {}})
        )
        then_click = rng.random() < 0.4
        if then_click:
            t = rng.randrange(len(labels_b))
            rt_b = {"target": f"e{t}", "confirm": {f"e{t}": f"✓ {labels_b[t]} opened"}}
            server.pages[f"{ep}/{slug}"] = PageSpec("click", title_b, body_b, theme_b, site, rt_b)
            goal = rng.choice(['Go to {u} and click "{l}"', 'Open {u}, then press "{l}"']).format(u=url, l=labels_b[t])
            variants.append("then_click")
        else:
            server.pages[f"{ep}/{slug}"] = maybe_error(
                PageSpec("arrive", title_b, body_b, theme_b, site, {"confirm": {}})
            )
            goal = rng.choice(["Go to {u}", "Open {u}", "Navigate to {u}", "Visit {u}"]).format(u=url)
        return Episode(ep, "navigate", goal, ep + "/a", variants=variants)

    link_key = rng.choice(list(keys_a))
    body_a = body_a.replace(f'data-k="{link_key}"', f'data-k="{link_key}" data-href="{ep}/{slug}"')
    server.pages[ep + "/a"] = PageSpec("arrive", title_a, body_a, theme, site, {"confirm": {}})
    server.pages[f"{ep}/{slug}"] = PageSpec("back", title_b, body_b, theme_b, site, runtime_variants({"confirm": {}}))
    goal = rng.choice(
        ["Go back to the previous page", "Go back", f'Return to the "{title_a}" page', "Navigate back one page"]
    )
    return Episode(ep, "back", goal, ep + "/a", setup_clicks=[link_key], variants=variants)
