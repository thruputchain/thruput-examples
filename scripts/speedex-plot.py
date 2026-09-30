#!/usr/bin/env python3
"""Graph the speedex benchmarks.

Reads the CSVs that `cargo test -p speedex --test quality` (execution quality, natively) and
`cargo test -p speedex --test testkit_gas` (gas, on a devnode) write, and draws:

  quality-vs-rounds.png   clearing error, unsettled trades and the gas of the price computation
                          against the tâtonnement round cap, one line per number of assets
  quality-vs-size.png     the same quality measures against the number of offers, at the cap the
                          examples configure (64), plus the rounds a batch actually needed
  gas-vs-size.png         what each part of a clearing costs against the number of occupied
                          cells, with a submission and a settlement for scale

Usage: speedex-plot.py [--quality CSV] [--gas CSV] [--out DIR]
with the defaults being the files the benchmarks write into `target/`.
"""

import argparse
import csv
import os
from collections import defaultdict

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

# One hue per series in a fixed order (an accessible, colorblind-checked categorical palette);
# a number of assets keeps its color across every figure.
PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
ASSET_COLORS = {3: PALETTE[0], 4: PALETTE[1], 5: PALETTE[2], 6: PALETTE[3], 8: PALETTE[4]}
CONFIGURED_CAP = 64
TEXT = "#333333"
GRID = "#e6e6e6"

plt.rcParams.update(
    {
        "font.size": 10,
        "axes.edgecolor": "#bbbbbb",
        "axes.labelcolor": TEXT,
        "axes.titlecolor": TEXT,
        "axes.titlesize": 11,
        "xtick.color": TEXT,
        "ytick.color": TEXT,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "grid.color": GRID,
        "grid.linewidth": 0.8,
        "legend.frameon": False,
        "lines.linewidth": 2,
        "lines.markersize": 6,
        "figure.dpi": 110,
    }
)


def read(path):
    with open(path, newline="") as f:
        return [{k: _num(v) for k, v in row.items()} for row in csv.DictReader(f)]


def _num(v):
    for cast in (int, float):
        try:
            return cast(v)
        except ValueError:
            pass
    return v


def mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs) if xs else float("nan")


def series(rows, key, x, y, where=lambda r: True):
    """Mean of `y(r)` at each `x(r)`, for each value of `key(r)`, over rows passing `where`."""
    groups = defaultdict(lambda: defaultdict(list))
    for r in rows:
        if where(r):
            groups[key(r)][x(r)].append(y(r))
    return {
        k: sorted((xv, mean(ys)) for xv, ys in by_x.items()) for k, by_x in sorted(groups.items())
    }


def draw(ax, lines, label=lambda k: f"{k} assets", log_x=True, log_y=False):
    for k, points in lines.items():
        xs, ys = zip(*points)
        ax.plot(xs, ys, marker="o", color=ASSET_COLORS.get(k, "#888888"), label=label(k))
    if log_x:
        ax.set_xscale("log", base=2)
    if log_y:
        ax.set_yscale("log")
    ax.grid(True, axis="y")
    ax.set_axisbelow(True)


def quality_vs_rounds(quality, gas, out):
    offers = 1000
    fig, axes = plt.subplots(1, 3, figsize=(13, 4))
    at_size = lambda r: r["offers"] == offers
    draw(
        axes[0],
        series(quality, lambda r: r["n"], lambda r: r["round_cap"], lambda r: r["price_error"], at_size),
        log_y=True,
    )
    axes[0].set_title("clearing error at the prices found")
    axes[0].set_ylabel("value of excess demand / value supplied")
    draw(
        axes[1],
        series(quality, lambda r: r["n"], lambda r: r["round_cap"], lambda r: r["shortfall_fraction"], at_size),
    )
    axes[1].set_title("unsettled trades")
    axes[1].set_ylabel("value past the band left untraded / all of it")
    gas_size = 32
    draw(
        axes[2],
        series(
            gas,
            lambda r: r["n"],
            lambda r: r["round_cap"],
            lambda r: r["gas_prices"] / 1e6,
            lambda r: r["kind"] == "measure" and r["status"] == "ok" and r["offers"] == gas_size,
        ),
    )
    axes[2].set_title("gas of the price computation (devnode)")
    axes[2].set_ylabel("million gas")
    for ax in axes:
        ax.set_xlabel("tâtonnement round cap")
    axes[0].legend(loc="upper right")
    fig.suptitle(
        f"Against the round cap: {offers} offers per batch (error and shortfall, mean of 5 batches); "
        f"{gas_size} offers (gas)",
        color=TEXT,
    )
    fig.tight_layout()
    fig.savefig(os.path.join(out, "quality-vs-rounds.png"))
    plt.close(fig)


def quality_vs_size(quality, out):
    fig, axes = plt.subplots(1, 3, figsize=(13, 4))
    at_cap = lambda r: r["round_cap"] == CONFIGURED_CAP
    draw(
        axes[0],
        series(quality, lambda r: r["n"], lambda r: r["offers"], lambda r: r["price_error"], at_cap),
        log_y=True,
    )
    axes[0].set_title("clearing error at the prices found")
    axes[0].set_ylabel("value of excess demand / value supplied")
    draw(
        axes[1],
        series(
            quality,
            lambda r: r["n"],
            lambda r: r["offers"],
            lambda r: 1 - r["fill_fraction"],
            at_cap,
        ),
    )
    axes[1].set_title("in the money but not traded")
    axes[1].set_ylabel("value in the money left untraded / all of it")
    draw(
        axes[2],
        series(quality, lambda r: r["n"], lambda r: r["offers"], lambda r: r["rounds"], at_cap),
    )
    axes[2].set_title("rounds tâtonnement ran")
    axes[2].set_ylabel("rounds")
    for ax in axes:
        ax.set_xlabel("offers in the batch")
    axes[0].legend(loc="upper right")
    fig.suptitle(
        f"Against batch size, at a cap of {CONFIGURED_CAP} rounds (mean of 5 batches)", color=TEXT
    )
    fig.tight_layout()
    fig.savefig(os.path.join(out, "quality-vs-size.png"))
    plt.close(fig)


def converged_measures(gas):
    """For each (assets, offers), the `measure_clearing` row at the largest round cap that
    completed: a converged clearing, unless the cap cut it short."""
    best = {}
    for r in gas:
        if r["kind"] != "measure" or r["status"] != "ok":
            continue
        key = (r["n"], r["offers"])
        if key not in best or r["round_cap"] > best[key]["round_cap"]:
            best[key] = r
    return list(best.values())


def gas_vs_size(gas, out):
    fig, axes = plt.subplots(1, 3, figsize=(13, 4))
    measured = converged_measures(gas)
    draw(
        axes[0],
        series(measured, lambda r: r["n"], lambda r: r["cells"], lambda r: r["gas_read"] / 1e6),
    )
    axes[0].set_title("reading the cells; dotted: a whole clear_batch")
    axes[0].set_ylabel("million gas")
    # The whole of a real clearing, and the single-offer transactions, for scale.
    whole = series(
        gas,
        lambda r: r["n"],
        lambda r: r["cells"],
        lambda r: r["gas_total"] / 1e6,
        lambda r: r["kind"] == "clear" and r["status"] == "ok",
    )
    for k, points in whole.items():
        xs, ys = zip(*points)
        axes[0].plot(xs, ys, linestyle=":", color=ASSET_COLORS.get(k, "#888888"))
    axes[0].plot([], [], linestyle=":", color="#888888", label=f"clear_batch, cap {CONFIGURED_CAP}")
    for kind, name, style in (("submit", "one submit_offer", "--"), ("settle", "one settle_offer", "-.")):
        g = [r["gas_total"] for r in gas if r["kind"] == kind and r["status"] == "ok"]
        if g:
            axes[0].axhline(mean(g) / 1e6, color="#888888", linewidth=1, linestyle=style, label=name)
    axes[0].legend(loc="upper left")

    draw(
        axes[1],
        series(
            measured,
            lambda r: r["n"],
            lambda r: r["cells"],
            lambda r: r["gas_prices"] / max(r["rounds"], 1) / 1e3,
        ),
    )
    axes[1].set_title("one round of tâtonnement")
    axes[1].set_ylabel("thousand gas")

    draw(
        axes[2],
        series(measured, lambda r: r["n"], lambda r: r["cells"], lambda r: r["gas_circulation"] / 1e6),
    )
    axes[2].set_title("circulation and fills")
    axes[2].set_ylabel("million gas")
    for ax in axes:
        ax.set_xlabel("occupied cells")
    fig.suptitle("Gas on a devnode, by batch size", color=TEXT)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "gas-vs-size.png"))
    plt.close(fig)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    target = os.path.join(here, "..", "target")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--quality", default=os.path.join(target, "speedex-quality.csv"))
    p.add_argument("--gas", default=os.path.join(target, "speedex-gas.csv"))
    p.add_argument("--out", default=os.path.join(target, "speedex-bench"))
    args = p.parse_args()
    os.makedirs(args.out, exist_ok=True)

    quality = read(args.quality) if os.path.exists(args.quality) else []
    gas = read(args.gas) if os.path.exists(args.gas) else []
    if quality:
        quality_vs_size(quality, args.out)
    if quality or gas:
        quality_vs_rounds(quality, gas, args.out)
    if gas:
        gas_vs_size(gas, args.out)
    print(f"figures in {args.out}")


if __name__ == "__main__":
    main()
