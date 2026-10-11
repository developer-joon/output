#!/bin/sh
# 릴리스 (2026-10-11): 초안 만들기 → 서명·공증한 DMG·zip·latest-mac.yml 올리기 → 공개.
# electron-builder가 DMG·zip마다 릴리스를 동시에 만들려다 하나가 422로 실패한 일(v1.0.1)이 있어 초안을 먼저 만든다.
# 초안인 동안은 자동 업데이트가 보지 않으므로 반쯤 올라간 릴리스를 받을 일이 없다.
set -eu
V="v$(node -p "require('./package.json').version")"
REPO=developer-joon/output
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "커밋하지 않은 변경이 있습니다" >&2; exit 1; fi
git fetch -q origin master
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/master)" ]; then echo "HEAD가 origin/master와 다릅니다 — 먼저 푸시하세요" >&2; exit 1; fi
gh release create "$V" -R "$REPO" --draft --target "$(git rev-parse HEAD)" --title "$V" --notes ""
APPLE_KEYCHAIN_PROFILE=output GH_TOKEN="$(gh auth token)" npx electron-builder --mac dmg zip --universal --publish always
gh release edit "$V" -R "$REPO" --draft=false --latest
gh release view "$V" -R "$REPO" --json assets --jq '.assets[].name'
