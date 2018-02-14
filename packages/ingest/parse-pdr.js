/**
 * This module includes tools for validating PDRs
 * and generating PDRD and PAN messages
 */

'use strict';

const fs = require('fs');
const pvl = require('@cumulus/pvl/t');
const { PDRParsingError } = require('@cumulus/common/errors');

function getItem(spec, pdrName, name, must = true) {
  const item = spec.get(name);
  if (item) {
    return item.value;
  }

  if (must) {
    throw new PDRParsingError(name, pdrName);
  }

  return null;
}

/**
 * Makes sure that a FILE Spec has all the required files and returns
 * the content as an object. Throws error if anything is missing
 * For more info refer to https://github.com/cumulus-nasa/cumulus-api/issues/104#issuecomment-285744333
 *
 * @param {object} spec PDR spec object generated by PVL
 * @returns {object} throws error if failed
 */
function parseSpec(pdrName, spec) {
  const get = getItem.bind(null, spec, pdrName);

  // check each file_spec has DIRECTORY_ID, FILE_ID, FILE_SIZE
  const path = get('DIRECTORY_ID');
  const filename = get('FILE_ID');
  const fileSize = get('FILE_SIZE');

  const checksumType = get('FILE_CKSUM_TYPE', false);
  const checksumValue = get('FILE_CKSUM_VALUE', false);

  // if it has cksum, make sure both FILE_CKSUM_TYPE and FILE_CKSUM_VALUE are present
  if (checksumType || checksumValue) {
    if (!checksumType) {
      throw new PDRParsingError('MISSING FILE_CKSUM_TYPE PARAMETER');
    }

    if (!checksumValue) {
      throw new PDRParsingError('MISSING FILE_CKSUM_VALUE PARAMETER');
    }
  }

  // make sure FILE_CKSUM_TYPE value is CKSUM
  if (checksumType && checksumType !== 'CKSUM') {
    throw new PDRParsingError('UNSUPPORTED CHECKSUM TYPE');
  }

  // make sure FILE_CKSUM_VALUE is numeric
  if (checksumValue && typeof checksumValue !== 'number') {
    throw new PDRParsingError('FILE_CKSUM_VALUE', pdrName);
  }

  const name = filename;
  return { path, name, fileSize, checksumType, checksumValue };
}
module.exports.parseSpec = parseSpec;

function extractGranuleId(fileName, regex) {
  const test = new RegExp(regex);
  const match = fileName.match(test);

  if (match) {
    return match[1];
  }
  return fileName;
}

module.exports.parsePdr = function parsePdr(pdrFilePath, collection, pdrName) {
  // then read the file and and pass it to parser
  const pdrFile = fs.readFileSync(pdrFilePath);
  const obj = {
    granules: []
  };

  // because MODAPS PDRs do not follow the standard ODL spec
  // we have to make sure there are spaces before and after every
  // question mark
  let pdrString = pdrFile.toString().replace(/((\w*)=(\w*))/g, '$2 = $3');

  // temporary fix for PVL not recognizing quoted strings as symbols
  pdrString = pdrString.replace(/"/g, '');

  let parsed = pvl.pvlToJS(pdrString);

  // check if the PDR has groups
  // if so, get the objects inside the first group
  // TODO: handle cases where there are more than one group
  const groups = parsed.groups();
  if (groups.length > 0) {
    parsed = groups[0];
  }

  // Get all the file groups
  const fileGroups = parsed.objects('FILE_GROUP');

  for (const group of fileGroups) {
    // get all the file specs in each group
    const specs = group.objects('FILE_SPEC');
    let dataType = group.get('DATA_TYPE');

    if (!dataType) throw new PDRParsingError('DATA_TYPE is missing');

    dataType = dataType.value;

    // FIXME This is a very generic error
    if (specs.length === 0) {
      throw new Error();
    }

    const files = specs.map(parseSpec.bind(null, pdrName));
    const granuleId = extractGranuleId(files[0].name, collection.granuleIdExtraction);

    obj.granules.push({
      granuleId,
      dataType,
      granuleSize: files.reduce((total, file) => total + file.fileSize, 0),
      files
    });
  }

  // check file count
  const fileCount = obj.granules.reduce((t, g) => t + g.files.length, 0);
  const expectedFileCount = parsed.get('TOTAL_FILE_COUNT').value;
  if (fileCount !== expectedFileCount) {
    throw new PDRParsingError('FILE COUNT doesn\'t match expected file count');
  }

  obj.granulesCount = fileGroups.length;
  obj.filesCount = fileCount;
  obj.totalSize = obj.granules.reduce((t, g) => t + g.granuleSize, 0);

  // Example object produced
  // {
  //    "path": "/TEST_B/Cumulus/DATA/ID1612101200",
  //    "filename": "pg-PR1A0000-2016121001_000_002",
  //    "fileSize": 5975257,
  //    "checksumType": "CKSUM",
  //    "checksumValue": 299257224
  //  }

  return obj;
};
