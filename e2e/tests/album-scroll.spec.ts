import { expect, test, type Page } from '@playwright/test';

import { baseURL, createSearchResponse, stubArtistPage, stubShellApis } from '../utils/mockShell';

const artistId = 'artist-scroll';
const artistName = 'Scroll Artist';
const albumId = 'album-scroll-primary';
const relatedAlbumId = 'album-scroll-related';
const albumTitle = 'Scrolling Album';
const relatedAlbumTitle = 'Related Album';
const targetTrackId = 'track-25';
const targetTrackTitle = 'Album track 25';
const searchQuery = 'scroll target';

function createAlbumTracks(sourceAlbumId: string, count = 40) {
    return Array.from({ length: count }, (_, index) => {
        const trackNumber = index + 1;
        return {
            id: `track-${trackNumber}`,
            title: `Album track ${trackNumber}`,
            duration: 180 + index,
            track_number: trackNumber,
            volume_number: 1,
            album_id: sourceAlbumId,
            album_title: sourceAlbumId === albumId ? albumTitle : relatedAlbumTitle,
            artist_id: artistId,
            artist_name: artistName,
            album_cover: null,
            quality: 'LOSSLESS',
            explicit: false,
            downloaded: false,
            is_downloaded: false,
            is_monitored: false,
            monitor: false,
            files: [],
        };
    });
}

async function expectAlbumDeepScrolledToTargetTrack(page: Page) {
    await page.waitForURL(new RegExp(`/album/${albumId}$`), { timeout: 10_000 });

    const targetTrackRow = page.locator(`[data-album-track-id="${targetTrackId}"]`).first();
    await expect(targetTrackRow).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);

    const targetTrackInViewport = await targetTrackRow.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
    });

    expect(targetTrackInViewport).toBe(true);
}

async function seedLibraryTracksTab(page: Page) {
    await page.addInitScript(() => {
        window.localStorage.setItem('discogenius_library_settings', JSON.stringify({
            settingsVersion: 2,
            selectedTab: 'tracks',
        }));
    });
}

async function stubLibraryTrackListFixtures(page: Page) {
    const primaryTracks = createAlbumTracks(albumId);

    await page.route((url) => url.pathname === '/api/v1/track', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                items: primaryTracks,
                total: primaryTracks.length,
                limit: 100,
                offset: 0,
                hasMore: false,
            }),
        });
    });
}

async function stubGlobalSearchTrackFixtures(page: Page) {
    await page.route('**/api/v1/search**', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(createSearchResponse({
                tracks: [
                    {
                        id: targetTrackId,
                        name: targetTrackTitle,
                        type: 'track',
                        subtitle: artistName,
                        monitored: false,
                        in_library: true,
                        duration: 205,
                        imageId: null,
                    },
                ],
            })),
        });
    });

    await page.route(`**/api/v1/track/${targetTrackId}`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                id: targetTrackId,
                title: targetTrackTitle,
                album_id: albumId,
                album_title: albumTitle,
                artist_id: artistId,
                artist_name: artistName,
            }),
        });
    });
}

async function stubGlobalSearchAlbumFixture(page: Page) {
    await page.route('**/api/v1/search**', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(createSearchResponse({
                albums: [{
                    id: relatedAlbumId,
                    name: relatedAlbumTitle,
                    type: 'album',
                    subtitle: artistName,
                    monitored: false,
                    in_library: true,
                    quality: 'LOSSLESS',
                    imageId: null,
                }],
            })),
        });
    });
}

async function stubAlbumPageFixtures(page: Page) {
    const primaryTracks = createAlbumTracks(albumId);
    const relatedTracks = createAlbumTracks(relatedAlbumId, 8);

    const albums = {
        [albumId]: {
            id: albumId,
            title: albumTitle,
            artist_id: artistId,
            artist_name: artistName,
            cover_id: null,
            cover: null,
            cover_art_url: null,
            provider_cover_id: null,
            vibrant_color: null,
            release_date: '2024-01-01',
            quality: 'LOSSLESS',
            explicit: false,
            is_monitored: false,
            is_downloaded: false,
            downloaded: 0,
            monitored_lock: false,
            source: 'musicbrainz',
        },
        [relatedAlbumId]: {
            id: relatedAlbumId,
            title: relatedAlbumTitle,
            artist_id: artistId,
            artist_name: artistName,
            cover_id: null,
            cover: null,
            cover_art_url: null,
            provider_cover_id: null,
            vibrant_color: null,
            release_date: '2024-02-02',
            quality: 'LOSSLESS',
            explicit: false,
            is_monitored: false,
            is_downloaded: false,
            downloaded: 0,
            monitored_lock: false,
            source: 'musicbrainz',
        },
    } as const;

    const trackLists = {
        [albumId]: primaryTracks,
        [relatedAlbumId]: relatedTracks,
    } as const;

    await page.route(/\/api\/v1\/album\/[^/?]+\/(page|library-availability)$/, async (route) => {
        const url = new URL(route.request().url());
        const match = url.pathname.match(/\/api\/v1\/album\/([^/]+)\/(page|library-availability)$/);
        const currentAlbumId = match?.[1];
        const endpoint = match?.[2];

        if (!currentAlbumId || !(currentAlbumId in albums)) {
            await route.fallback();
            return;
        }

        if (endpoint === 'library-availability') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    releaseGroupId: currentAlbumId === albumId ? 1 : 2,
                    releaseGroupMbid: currentAlbumId,
                    libraries: [],
                    releases: [],
                }),
            });
            return;
        }

        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                album: {
                    ...albums[currentAlbumId as keyof typeof albums],
                    track_count: trackLists[currentAlbumId as keyof typeof trackLists].length,
                },
                tracks: trackLists[currentAlbumId as keyof typeof trackLists],
                otherVersions: [],
                associatedVideos: [],
                artistPicture: null,
                artistCoverImageUrl: null,
            }),
        });
    });

    await stubArtistPage(page, {
        artistId,
        artistName,
        monitored: false,
        rowsBySection: {
            tracks: [{
                modules: [{
                    type: 'TRACK_LIST',
                    title: 'Top tracks',
                    items: [{
                        ...primaryTracks[24],
                        duration: 205,
                    }],
                }],
            }],
        },
    });
}

test.describe('Album scroll behavior', () => {
    test('plain album navigation resets the album page to the top', async ({ page }) => {
        await stubShellApis(page);
        await stubAlbumPageFixtures(page);
        await stubGlobalSearchAlbumFixture(page);

        await page.goto(`${baseURL}/album/${albumId}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(albumTitle, { exact: true }).first()).toBeVisible();

        await page.evaluate(() => {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' });
        });
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);

        const searchBox = page.getByRole('searchbox', { name: 'Search artists, albums, tracks, or videos' });
        await searchBox.fill(relatedAlbumTitle);
        const searchResults = page.getByRole('dialog', { name: 'Search results' });
        await expect(searchResults).toBeVisible();
        await searchResults.getByRole('tab', { name: 'Albums' }).click();
        await searchResults.getByText(relatedAlbumTitle, { exact: true }).click();
        await page.waitForURL(new RegExp(`/album/${relatedAlbumId}$`), { timeout: 10_000 });
        await expect(page.getByText(relatedAlbumTitle, { exact: true }).first()).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(32);
    });

    test('artist top track navigation opens the album scrolled to the selected track', async ({ page }) => {
        await stubShellApis(page);
        await stubAlbumPageFixtures(page);

        await page.goto(`${baseURL}/artist/${artistId}`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator(`[data-album-track-id="${targetTrackId}"]`).first()).toBeVisible();

        // Activate the row itself. A coordinate click can land on the nested
        // album link, which intentionally performs a plain (non-deep) route.
        await page.locator(`[data-album-track-id="${targetTrackId}"]`).first().press('Enter');
        await expectAlbumDeepScrolledToTargetTrack(page);
    });

    test('library track row navigation opens the album scrolled to the selected track', async ({ page }) => {
        await stubShellApis(page);
        await stubAlbumPageFixtures(page);
        await stubLibraryTrackListFixtures(page);
        await seedLibraryTracksTab(page);

        await page.goto(baseURL, { waitUntil: 'domcontentloaded' });

        const trackList = page.getByRole('grid', { name: 'Track list' });
        await expect(trackList).toBeVisible();

        await trackList.getByText(targetTrackTitle, { exact: true }).click();
        await expectAlbumDeepScrolledToTargetTrack(page);
    });

    test('global search track result navigation opens the album scrolled to the selected track', async ({ page }) => {
        await stubShellApis(page);
        await stubAlbumPageFixtures(page);
        await stubGlobalSearchTrackFixtures(page);

        await page.goto(`${baseURL}/search`, { waitUntil: 'domcontentloaded' });

        const searchBox = page.getByRole('searchbox', { name: 'Search artists, albums, tracks, or videos' });
        await searchBox.fill(searchQuery);

        const searchResults = page.getByRole('dialog', { name: 'Search results' });
        await expect(searchResults).toBeVisible();

        await searchResults.getByRole('tab', { name: 'Tracks' }).click();
        await expect(searchResults.getByText(targetTrackTitle, { exact: true })).toBeVisible();

        await searchResults.getByText(targetTrackTitle, { exact: true }).click();
        await expectAlbumDeepScrolledToTargetTrack(page);
    });
});
