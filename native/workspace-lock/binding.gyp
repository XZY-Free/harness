{
  "targets": [
    {
      "target_name": "workspace_lock",
      "sources": ["src/mutex.cc"],
      "defines": ["NAPI_VERSION=8"],
      "cflags_cc": ["-fexceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "11.0"
      }
    }
  ]
}
