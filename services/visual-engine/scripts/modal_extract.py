"""Run feature extraction on a Modal GPU (same code path as local CPU extraction).

Usage:
  modal volume create gnsis-visual-data
  modal volume put gnsis-visual-data ~/data/train /train
  modal run scripts/modal_extract.py --split train --device cuda --res 896 --mode 16x
  modal volume get gnsis-visual-data /feat/train-896-16x.pt ~/data/feat/
"""

from pathlib import Path

import modal

HERE = Path(__file__).resolve().parents[1]
MODEL_ID = "openbmb/MiniCPM-V-4.6"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "torch==2.13.0", "torchvision==0.28.0", "transformers==5.16.1", "huggingface-hub", "pillow", "numpy", "psutil"
    )
    .run_commands(
        f"python -c \"from huggingface_hub import snapshot_download; snapshot_download('{MODEL_ID}', local_dir='/model')\""
    )
    .add_local_dir(HERE / "gnsis_visual", "/app/gnsis_visual")
    .add_local_dir(HERE / "scripts", "/app/scripts")
)
e2e_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("fonts-liberation", "fonts-dejavu-core", "fonts-jetbrains-mono")
    .pip_install(
        "torch==2.13.0",
        "torchvision==0.28.0",
        "transformers==5.16.1",
        "huggingface-hub",
        "pillow",
        "numpy",
        "psutil",
        "playwright==1.62.0",
    )
    .run_commands("playwright install --with-deps chromium")
    .run_commands(
        f"python -c \"from huggingface_hub import snapshot_download; snapshot_download('{MODEL_ID}', local_dir='/model')\""
    )
    .add_local_dir(HERE / "gnsis_visual", "/app/gnsis_visual")
    .add_local_dir(HERE / "scripts", "/app/scripts")
)
volume = modal.Volume.from_name("gnsis-visual-data", create_if_missing=True)
app = modal.App("gnsis-visual-extract", image=image)


@app.function(gpu="L4", volumes={"/data": volume}, timeout=4 * 3600)
def extract(split: str, device: str, res: int, mode: str, dtype: str) -> str:
    import subprocess

    out = f"/data/feat/{split}-{res}-{mode}.pt"
    subprocess.run(
        [
            "python",
            "/app/scripts/extract.py",
            "--data",
            f"/data/{split}",
            "--out",
            out,
            "--model",
            "/model",
            "--device",
            device,
            "--res",
            str(res),
            "--mode",
            mode,
            "--dtype",
            dtype,
        ],
        check=True,
    )
    volume.commit()
    return out


@app.function(gpu="L4", volumes={"/data": volume}, timeout=3600)
def extract_shard(split: str, res: int, mode: str, dtype: str, shard: int, shards: int) -> str:
    import subprocess

    out = f"/data/feat/{split}-{res}-{mode}.{shard}of{shards}.pt"
    subprocess.run(
        [
            "python",
            "/app/scripts/extract.py",
            "--data",
            f"/data/{split}",
            "--out",
            out,
            "--model",
            "/model",
            "--device",
            "cuda",
            "--res",
            str(res),
            "--mode",
            mode,
            "--dtype",
            dtype,
            "--shard",
            str(shard),
            "--shards",
            str(shards),
        ],
        check=True,
    )
    volume.commit()
    return out


@app.function(gpu="L4", image=e2e_image, volumes={"/data": volume}, timeout=3600, memory=32768)
def train(res: int, mode: str, shards: int, epochs: int) -> str:
    import subprocess

    feat = [f"/data/feat/train-{res}-{mode}.{i}of{shards}.pt" for i in range(shards)]
    out = f"/data/heads/jev-{res}-{mode}.pt"
    subprocess.run(
        [
            "python",
            "/app/scripts/train_head.py",
            "--train",
            *feat,
            "--test",
            f"/data/feat/test-{res}-{mode}.pt",
            "--out",
            out,
            "--epochs",
            str(epochs),
            "--device",
            "cuda",
        ],
        check=True,
    )
    volume.commit()
    return out


@app.function(gpu="L4", image=e2e_image, volumes={"/data": volume}, timeout=3 * 3600)
def e2e(head: str, res: int, mode: str, episodes: int, seed0: int, tag: str) -> dict:
    import json
    import subprocess

    out = f"/data/e2e/{tag}.json"
    subprocess.run(
        [
            "python",
            "/app/scripts/eval_e2e.py",
            "--model",
            "/model",
            "--head",
            head,
            "--out",
            out,
            "--device",
            "cuda",
            "--dtype",
            "bfloat16",
            "--res",
            str(res),
            "--mode",
            mode,
            "--episodes",
            str(episodes),
            "--seed0",
            str(seed0),
        ],
        check=True,
    )
    volume.commit()
    return json.loads(open(out).read())["summary"]


@app.function(gpu="L4", timeout=1800)
def bench(res: int, mode: str, dtype: str) -> dict:
    import subprocess

    proc = subprocess.run(
        [
            "python",
            "/app/scripts/bench_backbone.py",
            "--model",
            "/model",
            "--device",
            "cuda",
            "--res",
            str(res),
            "--mode",
            mode,
            "--dtype",
            dtype,
            "--json",
        ],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    import json

    return json.loads(proc.stdout.strip().splitlines()[-1])


@app.local_entrypoint()
def main(split: str = "train", device: str = "cuda", res: int = 896, mode: str = "16x", dtype: str = "float32") -> None:
    print(extract.remote(split, device, res, mode, dtype))


@app.local_entrypoint()
def gpu_bench() -> None:
    import json

    configs = [(896, "16x", "float32"), (896, "16x", "bfloat16"), (672, "16x", "bfloat16"), (896, "4x", "bfloat16")]
    for result in bench.starmap(configs):
        print(json.dumps(result))


@app.local_entrypoint()
def sharded(split: str = "train", res: int = 896, mode: str = "16x", dtype: str = "bfloat16", shards: int = 8) -> None:
    args = [(split, res, mode, dtype, i, shards) for i in range(shards)]
    for out in extract_shard.starmap(args):
        print(out)


@app.local_entrypoint()
def train_head(res: int = 896, mode: str = "16x", shards: int = 8, epochs: int = 30) -> None:
    print(train.remote(res, mode, shards, epochs))


@app.local_entrypoint()
def e2e_eval(res: int = 896, mode: str = "16x", episodes: int = 50, shards: int = 4, seed0: int = 50_000) -> None:
    import json

    head = f"/data/heads/jev-{res}-{mode}.pt"
    args = [(head, res, mode, episodes, seed0 + i * episodes, f"e2e-{res}-{mode}-{i}") for i in range(shards)]
    for summary in e2e.starmap(args):
        print(json.dumps(summary))
