var fs = require('fs');
var path = require('path');
var exists = fs.existsSync || path.existsSync;

var Struct = require('./struct');
var vendors = require('./vendors');
var labels = require('./labels');

'ArrayBuffer' in global || function(s){
  for (var k in s) global[k] = s[k];
}(process.binding('typed_array'));



module.exports = {
  listFonts: listFonts,
  loadFont: loadFont,
  Font: Font
};



var fontFolder = ({
  win32:  '/Windows/fonts',
  darwin: '/Library/Fonts',
  linux: '/usr/share/fonts/truetype'
})[process.platform];



function listFonts(){
  return fs.readdirSync(fontFolder);
}



function loadFont(filename){
  var resolved = path._makeLong(path.resolve(fontFolder, filename));
  if (exists(resolved)) {
    return new Font(fs.readFileSync(resolved), filename);
  } else {
    throw new Error(resolved + ' not found');
  }
}


function Font(buffer, filename){
  this.filename = filename;
  this.name = filename.slice(0, -path.extname(filename).length);
  var data = this.data = buffer;
  var index = this.index = Index(data, 0);
  index.tableIndex = index.tableIndex.reduce(function(r,s,i){
    r[s.tag.replace(/[\s\/]/g,'')] = index.tableIndex[i];
    Object.defineProperty(index.tableIndex[i], 'tag', { enumerable:false });
    return r
  }, {});
  var os2 = this.os2 = OS2.readStructs(data, index.tableIndex.OS2.offset);

  os2.weightClass = labels.weights[os2.weightClass / 100 - 1];
  os2.widthClass = labels.widths[os2.widthClass - 1];
  os2.selection = bitfield(os2.selection, 16, labels.selection);
  os2.class = Object.keys(labels.classes)[os2.class];
  os2.subclass = labels.classes[os2.class][os2.subclass];
  os2.panose = panose(os2.panose);
  os2.vendorID in vendors && (os2.vendorID = vendors[os2.vendorID]);

  os2.codePages = bitfield(os2.codePages, 32, labels.codePageNames);
  os2.unicodePages = bitfield(os2.unicodePages, 32, labels.unicodeBlocks).reduce(function(r,s){
    return r[s] = labels.unicodeRanges[s], r;
  }, {});
}

lazyProperty(Font.prototype, ['data', 'filename']);


function struct(definition){
  var fields = [];
  var descriptors = Object.keys(definition).reduce(function(descriptors, property){
    var desc = Object.getOwnPropertyDescriptor(definition, property);
    if (desc.value instanceof StructDef) {
      fields.push(desc.value.create(property));
    } else if (Array.isArray(desc.value)) {
      desc = desc.value;
      var type = desc.shift();
      if (type === 'array' && typeof desc[0] === 'string') {
        desc[0] = Struct[desc[0]]();
      }
      fields.push(Struct[type].apply(Struct, [property].concat(desc)));
    } else if (typeof desc.value === 'string') {
      fields.push(Struct[desc.value](property));
    } else if (desc.value && desc.value.isStruct) {
      fields.push(Struct.struct.apply(Struct, [property].concat(desc.value)));
    } else {
      descriptors[property] = desc;
    }
    return descriptors;
  }, {});
  fields.push(descriptors);
  return Struct.create.apply(Struct, fields);
}


function recurse(o){
  return function(arrayBuffer, offset, count, callback){
    return o.source.readStructs(arrayBuffer, offset, count, function(value, offset){
      if (o.count) {
        count = value[o.count];
      }
      offset += value.byteLength;
      if (o.pointer) {
        offset = value[o.pointer];
      } else if (o.offset) {
        offset += value[o.offset];
      }
      value[o.name] = o.target.readStructs(arrayBuffer, offset, count, callback);
      //value.byteLength += o.target.byteLength * count;
    });
  }
}

function StructDef(name){
  this.name = name;
  StructDef[name] = this;
}
StructDef.prototype = {
  constructor: StructDef
}
StructDef.cache = {};


function ArrayDef(name, type, length){
  StructDef.apply(this, arguments);
  this.type = type;
  this.length = length;
}
ArrayDef.prototype = {
  __proto__: StructDef.prototype,
  constructor: ArrayDef,
  defType: 'array',
  create: function(name){
    return Struct.array(name || this.name, Struct[this.type](), this.length);
  }
};

function StringDef(name, length){
  StructDef.apply(this, arguments);
  this.length = length;
}
StringDef.prototype = {
  __proto__: StructDef.prototype,
  constructor: StringDef,
  defType: 'string',
  create: function(name){
    return Struct.string(name || this.name, this.length);
  }
};

function BitfieldDef(name, type, length, map){
  ArrayDef.apply(this, arguments);
  this.map = map;
}

BitfieldDef.prototype = {
  __proto__: ArrayDef.prototype,
  constructor: BitfieldDef,
  create: function(name){
    return Struct.array(name || this.name, Struct[this.type](), this.length, this.postProcess);
  },
  postProcess: function(data){
    var out = bitfield(data, this.type.byteLength, this.map);
  }
};



var Tag = new StringDef('Tag', 4);
var Version = new ArrayDef('Version', 'uint8', 4);
var LongDateTime = new ArrayDef('LongDateTime', 'int32', 2);
var Point = struct({ x: 'int16', y: 'int16' });
var Metrics = struct({ size: Point, offset: Point });

var TableIndex = struct({
  tag:      Tag,
  checksum: 'uint32',
  offset:   'uint32',
  length:   'uint32'
});

var FontIndex = struct({
  version:  Version,
  tables:   'uint16',
  range:    'uint16',
  selector: 'uint16',
  shift:    'uint16',
  get type(){
    var vers = this.version.join('');
    return vers === '0100' ? 'TrueType' : vers === 'OTTO' ? 'OpenType' : 'Unknown';
  }
});


var Index = recurse({
  source: FontIndex,
  target: TableIndex,
  name: 'tableIndex',
  count: 'tables'
});



var Head = struct({
  version: Version,
  fontRevision: 'int32' ,
  checkSumAdjustment: 'uint32',
  magicNumber: 'uint32',
  flags: 'uint16',
  unitsPerEm: 'uint16',
  created: LongDateTime ,
  modified: LongDateTime ,
  min: Point,
  max: Point,
  macStyle: 'uint16',
  lowestRecPPEM: 'uint16',
  fontDirectionHint : 'int16',
  indexToLocFormat: 'int16',
  glyphDataFormat: 'int16',
});


var NameIndex = struct({
  format: 'uint16',
  length: 'uint16',
  offset: 'uint16'
});

var NameRecord = struct({
  platformID: 'uint16',
  encodingID: 'uint16',
  languageID: 'uint16',
  nameID:     'uint16',
  length:     'uint16',
  offset:     'uint16',
  get name(){ return labels.nameIDs[this.nameID] }
});



var OS2 = struct({
  version:              'uint16',
  avgCharWidth:         'int16',
  weightClass:          'uint16',
  widthClass:           'uint16',
  type:                 'uint16',
  subscript:             Metrics,
  superscript:           Metrics,
  strikeout:            struct({ size: 'int16', position: 'int16' }),
  class:                'int8',
  subclass:             'int8',
  panose:               ['array', 'uint8', 10],
  unicodePages:         new BitfieldDef('unicodePages', 'uint32', 4, labels.unicodeRanges),
  vendorID:             Tag,
  selection:            'uint16',
  firstCharIndex:       'uint16',
  lastCharIndex:        'uint16',
  typographic:          struct({ ascender: 'int16', descender: 'int16', lineGap: 'int16' }),
  windowTypographic:    struct({ ascender: 'uint16', descender: 'uint16' }),
  codePages:           ['array', 'uint32', 2],
  xHeight:              'int16',
  capHeight:            'int16',
  defaultChar:          'uint16',
  breakChar:            'uint16',
  maxContext:           'uint16'
});




// data.seek(tags.head.offset);
// tags.head.version = data.version;
// data.move(14);
// var unitsPerEm = this.unitsPerEm = data.ushort();

// data.seek(tags.hhea.offset);
// tags.hhea.version = data.version;
// this.ascent  = data.fword() / unitsPerEm;
// this.descent = data.fword() / unitsPerEm;
// this.leading = data.fword() / unitsPerEm;

// tags.name || tagMissing('name');
// data.seek(tags.name.offset);
// var format = data.ushort();
// var namecount = data.ushort();
// var store = data.ushort();
// if (format === 0) {
//   var nameRecords = [];
//   while (namecount--) {
//     nameRecords.push({
//       platformID: data.ushort(),
//       encodingID: data.ushort(),
//       languageID: data.ushort(),
//       nameID: data.ushort(),
//       length: data.ushort(),
//       offset: data.ushort(),
//     });
//   }
//   this.names = nameRecords.reduce(function(ret, record, i){
//     var name = labels.nameIDs[record.nameID];
//     var val = data.string(record.length).replace(/\u0000/g, '');
//     if (name in ret && ret[name] !== val) {
//       ret[name] = [ ret[name], val ];
//     } else {
//       ret[name] = val;
//     }
//     return ret;
//       //platform: labels.platformIDs[record.platformID]
//   }, {});
// }





function bitfield(vals, size, labels){
  if (Array.isArray(vals)){
    return flatten(vals.map(function(val,i){
      return bitfield(val, size, labels[i]);
    }));
  }
  var out = [];
  for (var i=0; i < size; i++){
    if (!!(vals & 1 << i)) {
      out.push(labels[i]);
    }
  }
  return out;
}

function flatten(array){
  return array.reduce(function(r, v){
    if (Array.isArray(v)) {
      return r.concat(flatten(v));
    }
    r[r.length] = v;
    return r;
  }, []);
}

function panose(data){
  return Object.keys(labels.panose).reduce(function(r,s,i){
    if (data[i] > 1) {
      r[s] = labels.panose[s][data[i] - 2];
    }
    return r;
  }, {});
}




function lazyProperty(obj, name){
  if (Array.isArray(name)) {
    name.forEach(function(prop){
      lazyProperty(obj, prop);
    });
    return obj;
  }
  var visible = name[0] === '$';
  name = visible ? name.slice(1) : name;
  Object.defineProperty(obj, name, {
    configurable: true,
    enumerable: !visible,
    get: function(){},
    set: function(v){ Object.defineProperty(this, name, { value: v, writable: true }) }
  });
}

//'THESANSMONO-9-BLACK'
//


//console.log(loadFont('THESANSMONO-9-BLACK.ttf'));