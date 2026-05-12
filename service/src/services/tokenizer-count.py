import json
import sys
from pathlib import Path

from tokenizers import Tokenizer


def main():
    base_dir = Path(__file__).resolve().parents[2] / "deepseek_v3_tokenizer"
    tokenizer = Tokenizer.from_file(str(base_dir / "tokenizer.json"))
    payload = json.load(sys.stdin)
    texts = payload.get("texts", [])
    counts = [len(tokenizer.encode(text or "").ids) for text in texts]
    print(json.dumps({"counts": counts}, ensure_ascii=False))


if __name__ == "__main__":
    main()
