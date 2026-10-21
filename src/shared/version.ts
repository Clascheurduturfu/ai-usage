import manifest from '../../package.json'

/** The package manifest is the version source for the renderer and broker. */
export const APP_VERSION = manifest.version
export function displayVersion(version: string): string {
  return version.replace(/^(\d+)\.0\.0-beta\.(\d+)$/, '$1.0-beta-$2').replace(/^(\d+)\.0\.0-rc\.(\d+)$/, '$1.0-rc-$2')
}
export const APP_DISPLAY_VERSION = displayVersion(APP_VERSION)
