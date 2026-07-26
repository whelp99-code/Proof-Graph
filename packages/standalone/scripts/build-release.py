#!/usr/bin/env python3
import argparse, gzip, hashlib, json, os, pathlib, shutil, tarfile, zipfile
parser = argparse.ArgumentParser()
parser.add_argument('--root', default=pathlib.Path(__file__).resolve().parents[1])
parser.add_argument('--output-dir', default=None)
args = parser.parse_args()
root = pathlib.Path(args.root).resolve(); out = pathlib.Path(args.output_dir).resolve() if args.output_dir else root.parent
manifest = json.loads((root / 'BUILD_MANIFEST.json').read_text()); version = manifest['version']
name = f'ProofGraph-Standalone-v{version}'
staging_root = root / 'dist' / 'release'; staging = staging_root / name
shutil.rmtree(staging_root, ignore_errors=True); staging.mkdir(parents=True)
for entry in manifest['files']:
    src = root / entry['path']; dst = staging / entry['path']; dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst); os.chmod(dst, 0o755 if entry.get('executable') else 0o644)
shutil.copyfile(root / 'BUILD_MANIFEST.json', staging / 'BUILD_MANIFEST.json'); os.chmod(staging / 'BUILD_MANIFEST.json', 0o644)
fixed = (2026, 7, 26, 0, 0, 0)
zip_path = out / f'{name}.zip'
with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for file in sorted(staging.rglob('*')):
        if not file.is_file(): continue
        rel = pathlib.Path(name) / file.relative_to(staging); info = zipfile.ZipInfo(str(rel).replace(os.sep, '/'), fixed)
        info.compress_type = zipfile.ZIP_DEFLATED; info.external_attr = ((0o755 if os.access(file, os.X_OK) else 0o644) & 0xFFFF) << 16
        zf.writestr(info, file.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
tar_path = out / f'{name}.tar.gz'
with open(tar_path, 'wb') as raw:
    with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0, compresslevel=9) as gz:
        with tarfile.open(fileobj=gz, mode='w') as tf:
            for file in sorted(staging.rglob('*')):
                rel = pathlib.Path(name) / file.relative_to(staging); ti = tf.gettarinfo(str(file), arcname=str(rel)); ti.uid = ti.gid = 0; ti.uname = ti.gname = ''; ti.mtime = 0
                if file.is_file():
                    with open(file, 'rb') as fh: tf.addfile(ti, fh)
                else: tf.addfile(ti)
checks = {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in [zip_path, tar_path]}
checksum_path = out / f'{name}_SHA256SUMS'; checksum_path.write_text(''.join(f'{digest}  {filename}\n' for filename, digest in checks.items()))
print(json.dumps({'zip': str(zip_path), 'tar_gz': str(tar_path), 'sha256sums': str(checksum_path), 'checksums': checks}, indent=2))
