# Browser and visual regression tests

Run `pnpm test:browser` for Chromium and WebKit behavior and accessibility checks.
Run `STIVA_VISUAL_TESTS=1 pnpm test:browser` to include Chromium screenshots for
the current platform. Baselines cover light and dark workspaces on macOS and Linux.
WebKit deliberately runs behavior checks without screenshot comparisons.

CI enables visual comparisons in the pinned Linux x64 Playwright container. To
reproduce that environment on macOS:

```sh
docker build --platform linux/amd64 -f tests/browser/Dockerfile -t stiva-browser-tests:visual .
docker run --rm --platform linux/amd64 --ipc=host -e STIVA_VISUAL_TESTS=1 stiva-browser-tests:visual pnpm test:browser
```

For an intentional design change, generate new Linux baselines using:

```sh
docker run --rm --platform linux/amd64 --ipc=host -e STIVA_VISUAL_TESTS=1 \
  -v "$PWD/tests/browser/visual.spec.ts-snapshots:/work/tests/browser/visual.spec.ts-snapshots" \
  stiva-browser-tests:visual pnpm exec playwright test visual.spec.ts --project chromium --update-snapshots
```

Inspect both output images, rebuild the image to include them, and rerun without
`--update-snapshots` before accepting the change. For macOS baselines use
`STIVA_VISUAL_TESTS=1 pnpm exec playwright test visual.spec.ts --project chromium --update-snapshots`
and then repeat without `--update-snapshots`.

The tests fix viewport, locale, timezone, fixture data and motion preferences.
Keep macOS and Linux baselines separate because font rendering differs. When
updating Playwright, update the test-image and CI-image pins together and review
the baselines again. Windows visual baselines are not supplied; native Windows
packaged-app smoke checks run through the desktop CI matrix.
