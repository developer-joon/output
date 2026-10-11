{
  "targets": [{
    "target_name": "keysynth",
    "sources": ["src/keysynth.mm"],
    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
    "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8"],
    "xcode_settings": {
      "MACOSX_DEPLOYMENT_TARGET": "12.0",
      "CLANG_ENABLE_OBJC_ARC": "YES",
      "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
      "OTHER_CPLUSPLUSFLAGS": ["-std=c++17"]
    },
    "link_settings": { "libraries": ["-framework ApplicationServices", "-framework Carbon", "-framework AppKit"] }
  }]
}
