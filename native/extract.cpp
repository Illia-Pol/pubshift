// pubshift-extract — faithful .pub -> JSON IR extractor.
//
// Implements librevenge's RVNGDrawingInterface and records the entire callback
// stream as a JSON event list. Nothing is interpreted here: units, nesting and
// property names come through exactly as libmspub produced them. All semantic
// work (frames, layout, format mapping) happens downstream in TypeScript, where
// it is cheap to iterate and test.

#include <libmspub/MSPUBDocument.h>
#include <librevenge/librevenge.h>
#include <librevenge-stream/librevenge-stream.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <map>
#include <sstream>
#include <iostream>
#include <fstream>

namespace
{

std::string jsonEscape(const char *s)
{
  std::string out;
  if (!s) return out;
  for (const unsigned char *p = (const unsigned char *)s; *p; ++p)
  {
    switch (*p)
    {
    case '"':  out += "\\\""; break;
    case '\\': out += "\\\\"; break;
    case '\n': out += "\\n"; break;
    case '\r': out += "\\r"; break;
    case '\t': out += "\\t"; break;
    default:
      if (*p < 0x20)
      {
        char buf[8];
        snprintf(buf, sizeof(buf), "\\u%04x", *p);
        out += buf;
      }
      else out += (char)*p;   // UTF-8 passes through untouched
    }
  }
  return out;
}

const char *unitName(librevenge::RVNGUnit u)
{
  switch (u)
  {
  case librevenge::RVNG_INCH:    return "in";
  case librevenge::RVNG_PERCENT: return "%";
  case librevenge::RVNG_POINT:   return "pt";
  case librevenge::RVNG_TWIP:    return "twip";
  case librevenge::RVNG_GENERIC: return "";
  default:                       return "?";
  }
}

std::string doubleToStr(double d)
{
  char buf[64];
  snprintf(buf, sizeof(buf), "%.6g", d);
  return buf;
}

const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64(const unsigned char *data, unsigned long len)
{
  std::string out;
  out.reserve((len + 2) / 3 * 4);
  unsigned long i = 0;
  for (; i + 2 < len; i += 3)
  {
    unsigned v = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out += B64[(v >> 18) & 63]; out += B64[(v >> 12) & 63];
    out += B64[(v >> 6) & 63];  out += B64[v & 63];
  }
  if (i < len)
  {
    unsigned v = data[i] << 16;
    bool two = (i + 1 < len);
    if (two) v |= data[i + 1] << 8;
    out += B64[(v >> 18) & 63];
    out += B64[(v >> 12) & 63];
    out += two ? B64[(v >> 6) & 63] : '=';
    out += '=';
  }
  return out;
}

// FNV-1a — asset keys only, never a security boundary.
std::string hashKey(const unsigned char *data, unsigned long len)
{
  unsigned long long h = 1469598103934665603ULL;
  for (unsigned long i = 0; i < len; ++i) { h ^= data[i]; h *= 1099511628211ULL; }
  char buf[32];
  snprintf(buf, sizeof(buf), "a%016llx", h);
  return buf;
}

class JsonCollector : public librevenge::RVNGDrawingInterface
{
public:
  std::string events;                        // JSON array body, comma-separated
  std::map<std::string, std::string> assets; // key -> base64 payload
  unsigned eventCount = 0;

private:
  void emit(const char *type, const librevenge::RVNGPropertyList &props)
  {
    if (eventCount++) events += ",\n";
    events += "{\"t\":\"";
    events += type;
    events += "\"";
    std::string p = serializeList(props);
    if (!p.empty()) { events += ",\"p\":{" + p + "}"; }
    events += "}";
  }

  void emitBare(const char *type)
  {
    if (eventCount++) events += ",\n";
    events += "{\"t\":\"";
    events += type;
    events += "\"}";
  }

  // A property is emitted as a plain string, or as {"v":num,"u":unit} when it
  // carries a unit — geometry is worthless without knowing what it is measured in.
  std::string serializeProp(const librevenge::RVNGProperty *prop)
  {
    if (!prop) return "null";
    librevenge::RVNGUnit u = prop->getUnit();
    if (u == librevenge::RVNG_UNIT_ERROR)
      return "\"" + jsonEscape(prop->getStr().cstr()) + "\"";
    return "{\"v\":" + doubleToStr(prop->getDouble()) + ",\"u\":\"" + unitName(u) + "\"}";
  }

  std::string serializeVector(const librevenge::RVNGPropertyListVector &vec)
  {
    std::string out = "[";
    for (unsigned long i = 0; i < vec.count(); ++i)
    {
      if (i) out += ",";
      out += "{" + serializeList(vec[i]) + "}";
    }
    return out + "]";
  }

  std::string serializeList(const librevenge::RVNGPropertyList &props)
  {
    std::string out;
    bool first = true;
    librevenge::RVNGPropertyList::Iter it(props);
    for (it.rewind(); it.next();)
    {
      const char *key = it.key();
      if (!key) continue;

      // Image payloads are pulled out into the asset table so the event stream
      // stays small and identical images are stored once.
      if (strcmp(key, "office:binary-data") == 0)
      {
        const librevenge::RVNGProperty *prop = it();
        if (prop)
        {
          librevenge::RVNGString s = prop->getStr();
          std::string raw(s.cstr() ? s.cstr() : "");
          std::string k = hashKey((const unsigned char *)raw.data(), raw.size());
          if (!assets.count(k))
            assets[k] = base64((const unsigned char *)raw.data(), raw.size());
          if (!first) out += ",";
          first = false;
          out += "\"assetRef\":\"" + k + "\"";
          continue;
        }
      }

      if (!first) out += ",";
      first = false;
      out += "\"" + jsonEscape(key) + "\":";

      const librevenge::RVNGPropertyListVector *childVec = it.child();
      if (childVec) out += serializeVector(*childVec);
      else          out += serializeProp(it());
    }
    return out;
  }

public:
  void startDocument(const librevenge::RVNGPropertyList &p) override { emit("startDocument", p); }
  void endDocument() override { emitBare("endDocument"); }
  void setDocumentMetaData(const librevenge::RVNGPropertyList &p) override { emit("metaData", p); }
  void defineEmbeddedFont(const librevenge::RVNGPropertyList &p) override { emit("defineEmbeddedFont", p); }
  void startPage(const librevenge::RVNGPropertyList &p) override { emit("startPage", p); }
  void endPage() override { emitBare("endPage"); }
  void startMasterPage(const librevenge::RVNGPropertyList &p) override { emit("startMasterPage", p); }
  void endMasterPage() override { emitBare("endMasterPage"); }
  void setStyle(const librevenge::RVNGPropertyList &p) override { emit("setStyle", p); }
  void startLayer(const librevenge::RVNGPropertyList &p) override { emit("startLayer", p); }
  void endLayer() override { emitBare("endLayer"); }
  void startEmbeddedGraphics(const librevenge::RVNGPropertyList &p) override { emit("startEmbeddedGraphics", p); }
  void endEmbeddedGraphics() override { emitBare("endEmbeddedGraphics"); }
  void openGroup(const librevenge::RVNGPropertyList &p) override { emit("openGroup", p); }
  void closeGroup() override { emitBare("closeGroup"); }
  void drawRectangle(const librevenge::RVNGPropertyList &p) override { emit("drawRectangle", p); }
  void drawEllipse(const librevenge::RVNGPropertyList &p) override { emit("drawEllipse", p); }
  void drawPolygon(const librevenge::RVNGPropertyList &p) override { emit("drawPolygon", p); }
  void drawPolyline(const librevenge::RVNGPropertyList &p) override { emit("drawPolyline", p); }
  void drawPath(const librevenge::RVNGPropertyList &p) override { emit("drawPath", p); }
  void drawGraphicObject(const librevenge::RVNGPropertyList &p) override { emit("drawGraphicObject", p); }
  void drawConnector(const librevenge::RVNGPropertyList &p) override { emit("drawConnector", p); }
  void startTextObject(const librevenge::RVNGPropertyList &p) override { emit("startTextObject", p); }
  void endTextObject() override { emitBare("endTextObject"); }
  void startTableObject(const librevenge::RVNGPropertyList &p) override { emit("startTableObject", p); }
  void openTableRow(const librevenge::RVNGPropertyList &p) override { emit("openTableRow", p); }
  void closeTableRow() override { emitBare("closeTableRow"); }
  void openTableCell(const librevenge::RVNGPropertyList &p) override { emit("openTableCell", p); }
  void closeTableCell() override { emitBare("closeTableCell"); }
  void insertCoveredTableCell(const librevenge::RVNGPropertyList &p) override { emit("coveredTableCell", p); }
  void endTableObject() override { emitBare("endTableObject"); }
  void insertTab() override { emitBare("insertTab"); }
  void insertSpace() override { emitBare("insertSpace"); }
  void insertLineBreak() override { emitBare("insertLineBreak"); }
  void insertField(const librevenge::RVNGPropertyList &p) override { emit("insertField", p); }
  void openOrderedListLevel(const librevenge::RVNGPropertyList &p) override { emit("openOrderedList", p); }
  void openUnorderedListLevel(const librevenge::RVNGPropertyList &p) override { emit("openUnorderedList", p); }
  void closeOrderedListLevel() override { emitBare("closeOrderedList"); }
  void closeUnorderedListLevel() override { emitBare("closeUnorderedList"); }
  void openListElement(const librevenge::RVNGPropertyList &p) override { emit("openListElement", p); }
  void closeListElement() override { emitBare("closeListElement"); }
  void defineParagraphStyle(const librevenge::RVNGPropertyList &p) override { emit("defineParagraphStyle", p); }
  void openParagraph(const librevenge::RVNGPropertyList &p) override { emit("openParagraph", p); }
  void closeParagraph() override { emitBare("closeParagraph"); }
  void defineCharacterStyle(const librevenge::RVNGPropertyList &p) override { emit("defineCharacterStyle", p); }
  void openSpan(const librevenge::RVNGPropertyList &p) override { emit("openSpan", p); }
  void closeSpan() override { emitBare("closeSpan"); }
  void openLink(const librevenge::RVNGPropertyList &p) override { emit("openLink", p); }
  void closeLink() override { emitBare("closeLink"); }

  void insertText(const librevenge::RVNGString &text) override
  {
    if (eventCount++) events += ",\n";
    events += "{\"t\":\"text\",\"s\":\"" + jsonEscape(text.cstr()) + "\"}";
  }
};

void fail(const char *code, const char *message)
{
  printf("{\"ok\":false,\"error\":{\"code\":\"%s\",\"message\":\"%s\"}}\n",
         code, jsonEscape(message).c_str());
}

} // namespace

int main(int argc, char **argv)
{
  if (argc < 2)
  {
    fail("NO_INPUT", "usage: pubshift-extract <file.pub>");
    return 2;
  }

  librevenge::RVNGFileStream input(argv[1]);

  if (!libmspub::MSPUBDocument::isSupported(&input))
  {
    fail("UNSUPPORTED", "This file is not a Microsoft Publisher document that we can read.");
    return 1;
  }

  JsonCollector collector;
  bool ok = false;
  try
  {
    ok = libmspub::MSPUBDocument::parse(&input, &collector);
  }
  catch (const std::exception &e)
  {
    fail("PARSE_EXCEPTION", e.what());
    return 1;
  }
  catch (...)
  {
    fail("PARSE_EXCEPTION", "unknown error while reading the document");
    return 1;
  }

  if (!ok)
  {
    fail("PARSE_FAILED", "The document could not be read. It may be corrupt or password-protected.");
    return 1;
  }

  std::string out = "{\"ok\":true,\"events\":[\n" + collector.events + "\n],\"assets\":{";
  bool first = true;
  for (const auto &kv : collector.assets)
  {
    if (!first) out += ",";
    first = false;
    out += "\"" + kv.first + "\":\"" + kv.second + "\"";
  }
  out += "}}";

  fwrite(out.data(), 1, out.size(), stdout);
  return 0;
}
