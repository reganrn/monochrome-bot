'use strict';

const hifi = require('./hifi');

async function getDownloadLinks(track) {
  if (!track?.id) {
    throw new Error('This track does not have a valid ID.');
  }

  return {
    ...track,
    monochromeUrl: track.monochromeUrl || hifi.monochromeUrl(track.id, 'track'),
    tidalUrl: track.url || `https://tidal.com/browse/track/${track.id}`,
  };
}

module.exports = { getDownloadLinks };
