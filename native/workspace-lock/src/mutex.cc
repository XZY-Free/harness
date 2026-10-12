/*
 * A07 决策一：受管 Workspace scope 的**稳定文件内核排他锁**。
 *
 * 语义（shared-contracts / specs/A07-physical-writer.md）：
 *
 *   openAndTryLock(stablePath) -> { state: "held", handle } | { state: "busy" }
 *   unlockAndClose(handle)     -> { state: "released" | "already_released" }
 *
 * 设计约束（每一条都对应一个被审查报告点名的旧缺陷）：
 *
 * 1. **锁文件是稳定文件，不是目录**。旧实现用 `mkdir` 的原子性做互斥量，于是
 *    "回收"只能靠 `rename` + 删除别人的目录 —— 路径可以在"读持有者"与"rename"
 *    之间被重建，两个恢复者可以同时认为自己取得了锁。这里锁只落在**同一个 inode**
 *    上：只要锁文件不被 rename/unlink/recreate，内核锁就不会被绕过。本模块因此
 *    **从不** rename、unlink 或按 mtime 删除任何东西。
 *
 * 2. **持锁的是打开的文件描述**。POSIX 上 `flock(LOCK_EX)` 绑定到 open file
 *    description：持有进程被 SIGKILL 时由 OS 释放，不需要任何"stale 持有者"回收逻辑。
 *
 * 3. **句柄不得被用户 Writer 子进程继承**。以 `O_CLOEXEC` 打开，`spawn`/`exec` 之后
 *    子进程不会持有这把锁（否则 Broker 退出后锁会被一个无关的用户进程永久占住）。
 *
 * 4. **绝不在 AbortSignal/取消时提前解锁**：本模块没有取消概念，解锁只由显式
 *    `unlockAndClose` 或进程退出触发；等待由调用方用**非阻塞**尝试 + 有界异步等待实现，
 *    因此不会阻塞 Node 事件循环（旧实现等待期间会卡住 heartbeat）。
 *
 * 5. **失败必须显式**。非 POSIX 平台（当前正式 Broker 目标是 macOS 开发机与 Linux 容器）
 *    返回 `unsupported_platform` 错误，而不是退化成一个"总是成功"的假接口。
 */
#include <node_api.h>

#ifdef _WIN32

#include <string>

namespace {

napi_value ThrowUnsupportedPlatform(napi_env env) {
  napi_throw_error(env, "unsupported_platform",
                   "workspace-lock: Windows 上的等价实现（LockFileEx）尚未随本包落地；"
                   "当前正式 Broker 目标为 macOS/Linux，不提供总是成功的假实现。");
  return nullptr;
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_value unsupported;
  napi_create_function(env, "openAndTryLock", NAPI_AUTO_LENGTH,
                       [](napi_env e, napi_callback_info) -> napi_value {
                         return ThrowUnsupportedPlatform(e);
                       },
                       nullptr, &unsupported);
  napi_set_named_property(env, exports, "openAndTryLock", unsupported);
  napi_create_function(env, "unlockAndClose", NAPI_AUTO_LENGTH,
                       [](napi_env e, napi_callback_info) -> napi_value {
                         return ThrowUnsupportedPlatform(e);
                       },
                       nullptr, &unsupported);
  napi_set_named_property(env, exports, "unlockAndClose", unsupported);
  return exports;
}

#else  // POSIX

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#include <string>
#include <vector>

namespace {

/** 一个已取得的锁句柄。只持有 fd；fd < 0 表示已释放。 */
struct LockHandle {
  int fd = -1;
};

void FinalizeHandle(napi_env /*env*/, void* data, void* /*hint*/) {
  LockHandle* handle = static_cast<LockHandle*>(data);
  if (handle == nullptr) return;
  if (handle->fd >= 0) {
    // 进程退出/句柄被 GC 时兜底释放；正常路径已在 unlockAndClose 里释放过。
    ::flock(handle->fd, LOCK_UN);
    ::close(handle->fd);
    handle->fd = -1;
  }
  delete handle;
}

bool GetStringArgument(napi_env env, napi_value value, std::string* out) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  out->resize(length);
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, out->data(), length + 1, &written) != napi_ok) {
    return false;
  }
  out->resize(written);
  return true;
}

napi_value MakeStateObject(napi_env env, const char* state) {
  napi_value object;
  napi_create_object(env, &object);
  napi_value state_value;
  napi_create_string_utf8(env, state, NAPI_AUTO_LENGTH, &state_value);
  napi_set_named_property(env, object, "state", state_value);
  return object;
}

void ThrowErrno(napi_env env, const char* syscall, const std::string& path, int err) {
  std::string message = std::string("workspace-lock: ") + syscall + " 失败 path=" + path +
                        " errno=" + std::to_string(err) + " (" + strerror(err) + ")";
  napi_throw_error(env, "lock_syscall_failed", message.c_str());
}

bool GetRelativeComponents(napi_env env, const std::string& relative_path,
                           std::vector<std::string>* components) {
  if (relative_path.empty() || relative_path.front() == '/') {
    napi_throw_type_error(env, "invalid_argument",
                          "workspace-lock: managed path 必须是非空相对路径");
    return false;
  }
  size_t start = 0;
  while (start <= relative_path.size()) {
    const size_t end = relative_path.find('/', start);
    const std::string component = relative_path.substr(
        start, end == std::string::npos ? std::string::npos : end - start);
    if (component.empty() || component == "." || component == "..") {
      napi_throw_type_error(env, "invalid_argument",
                            "workspace-lock: managed path 含空段、. 或 ..");
      return false;
    }
    components->push_back(component);
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return !components->empty();
}

int OpenManagedParent(napi_env env, const std::string& root,
                      const std::vector<std::string>& components, bool create_missing,
                      bool* absent = nullptr) {
  int current = ::open(root.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (current < 0) {
    ThrowErrno(env, "open managed root", root, errno);
    return -1;
  }
  for (size_t index = 0; index + 1 < components.size(); ++index) {
    int next = ::openat(current, components[index].c_str(),
                        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (next < 0 && errno == ENOENT && !create_missing && absent != nullptr) {
      *absent = true;
      ::close(current);
      return -1;
    }
    if (next < 0 && errno == ENOENT && create_missing) {
      if (::mkdirat(current, components[index].c_str(), 0755) != 0 && errno != EEXIST) {
        const int err = errno;
        ::close(current);
        ThrowErrno(env, "mkdirat managed parent", components[index], err);
        return -1;
      }
      next = ::openat(current, components[index].c_str(),
                      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    }
    if (next < 0) {
      const int err = errno;
      ::close(current);
      ThrowErrno(env, "openat managed parent", components[index], err);
      return -1;
    }
    ::close(current);
    current = next;
  }
  return current;
}

/**
 * 以 root 目录描述符为锚写文件。每一级目录和最终文件都拒绝符号链接；路径查找与 IO
 * 不再重新从字面绝对路径开始，因此无法在授权后借链接替换逃出受管根。
 */
napi_value SecureWriteFile(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 3) {
    napi_throw_type_error(env, "invalid_argument",
                          "secureWriteFile(root, relativePath, content) 需要 3 个字符串参数");
    return nullptr;
  }
  std::string root;
  std::string relative_path;
  std::string content;
  if (!GetStringArgument(env, argv[0], &root) ||
      !GetStringArgument(env, argv[1], &relative_path) ||
      !GetStringArgument(env, argv[2], &content)) {
    napi_throw_type_error(env, "invalid_argument", "secureWriteFile 参数必须都是字符串");
    return nullptr;
  }
  std::vector<std::string> components;
  if (!GetRelativeComponents(env, relative_path, &components)) return nullptr;
  const int parent = OpenManagedParent(env, root, components, true);
  if (parent < 0) return nullptr;
  const std::string& name = components.back();
  const int fd = ::openat(parent, name.c_str(),
                          O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW, 0644);
  if (fd < 0) {
    const int err = errno;
    ::close(parent);
    ThrowErrno(env, "openat managed file", relative_path, err);
    return nullptr;
  }
  size_t offset = 0;
  while (offset < content.size()) {
    const ssize_t written = ::write(fd, content.data() + offset, content.size() - offset);
    if (written < 0) {
      if (errno == EINTR) continue;
      const int err = errno;
      ::close(fd);
      ::close(parent);
      ThrowErrno(env, "write managed file", relative_path, err);
      return nullptr;
    }
    offset += static_cast<size_t>(written);
  }
  if (::fsync(fd) != 0) {
    const int err = errno;
    ::close(fd);
    ::close(parent);
    ThrowErrno(env, "fsync managed file", relative_path, err);
    return nullptr;
  }
  ::close(fd);
  ::close(parent);
  return MakeStateObject(env, "written");
}

/** 删除普通文件时同样拒绝最终符号链接；不存在视为幂等成功。 */
napi_value SecureDeleteFile(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 2) {
    napi_throw_type_error(env, "invalid_argument",
                          "secureDeleteFile(root, relativePath) 需要 2 个字符串参数");
    return nullptr;
  }
  std::string root;
  std::string relative_path;
  if (!GetStringArgument(env, argv[0], &root) ||
      !GetStringArgument(env, argv[1], &relative_path)) {
    napi_throw_type_error(env, "invalid_argument", "secureDeleteFile 参数必须都是字符串");
    return nullptr;
  }
  std::vector<std::string> components;
  if (!GetRelativeComponents(env, relative_path, &components)) return nullptr;
  bool parent_absent = false;
  const int parent = OpenManagedParent(env, root, components, false, &parent_absent);
  if (parent_absent) return MakeStateObject(env, "absent");
  if (parent < 0) return nullptr;
  const std::string& name = components.back();
  struct stat stats;
  if (::fstatat(parent, name.c_str(), &stats, AT_SYMLINK_NOFOLLOW) != 0) {
    const int err = errno;
    ::close(parent);
    if (err == ENOENT) return MakeStateObject(env, "absent");
    ThrowErrno(env, "fstatat managed file", relative_path, err);
    return nullptr;
  }
  if (S_ISLNK(stats.st_mode)) {
    ::close(parent);
    napi_throw_error(env, "managed_path_symlink",
                     "workspace-lock: 拒绝删除符号链接形式的受管文件目标");
    return nullptr;
  }
  if (::unlinkat(parent, name.c_str(), 0) != 0) {
    const int err = errno;
    ::close(parent);
    if (err == ENOENT) return MakeStateObject(env, "absent");
    ThrowErrno(env, "unlinkat managed file", relative_path, err);
    return nullptr;
  }
  ::close(parent);
  return MakeStateObject(env, "deleted");
}

/**
 * 取得稳定锁文件的**非阻塞**排他锁。
 *
 * 返回：
 * - `{ state: "held", handle }`：已持有；调用方必须最终 `unlockAndClose`。
 * - `{ state: "busy" }`：他人持有。调用方按自己的有界等待重试，**不得**删除/改名锁文件。
 * - 抛出：真实系统错误（权限、路径不存在等）。绝不把错误吞成 busy。
 */
napi_value OpenAndTryLock(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
    napi_throw_type_error(env, "invalid_argument", "openAndTryLock(stablePath) 需要 1 个字符串参数");
    return nullptr;
  }
  std::string path;
  if (!GetStringArgument(env, argv[0], &path)) {
    napi_throw_type_error(env, "invalid_argument", "openAndTryLock(stablePath) 需要字符串路径");
    return nullptr;
  }
  if (path.empty()) {
    napi_throw_type_error(env, "invalid_argument", "openAndTryLock(stablePath) 不接受空路径");
    return nullptr;
  }

  // O_CLOEXEC：spawn/exec 出的用户 Writer 子进程不得继承这把锁。
  const int fd = ::open(path.c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0644);
  if (fd < 0) {
    ThrowErrno(env, "open", path, errno);
    return nullptr;
  }

  if (::flock(fd, LOCK_EX | LOCK_NB) != 0) {
    const int err = errno;
    ::close(fd);
    if (err == EWOULDBLOCK || err == EAGAIN) {
      return MakeStateObject(env, "busy");
    }
    ThrowErrno(env, "flock", path, err);
    return nullptr;
  }

  LockHandle* handle = new LockHandle{fd};
  napi_value external;
  if (napi_create_external(env, handle, FinalizeHandle, nullptr, &external) != napi_ok) {
    ::flock(fd, LOCK_UN);
    ::close(fd);
    delete handle;
    napi_throw_error(env, "internal_error", "workspace-lock: 无法创建锁句柄");
    return nullptr;
  }
  napi_value result = MakeStateObject(env, "held");
  napi_set_named_property(env, result, "handle", external);
  return result;
}

/** 释放并关闭句柄。幂等：重复释放返回 `already_released`。 */
napi_value UnlockAndClose(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
    napi_throw_type_error(env, "invalid_argument", "unlockAndClose(handle) 需要 1 个句柄参数");
    return nullptr;
  }
  void* data = nullptr;
  if (napi_get_value_external(env, argv[0], &data) != napi_ok || data == nullptr) {
    napi_throw_type_error(env, "invalid_argument", "unlockAndClose(handle) 收到无效句柄");
    return nullptr;
  }
  LockHandle* handle = static_cast<LockHandle*>(data);
  if (handle->fd < 0) return MakeStateObject(env, "already_released");
  ::flock(handle->fd, LOCK_UN);
  ::close(handle->fd);
  handle->fd = -1;
  return MakeStateObject(env, "released");
}

napi_value HandleIsReleased(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
    napi_throw_type_error(env, "invalid_argument", "isReleased(handle) 需要 1 个句柄参数");
    return nullptr;
  }
  void* data = nullptr;
  if (napi_get_value_external(env, argv[0], &data) != napi_ok || data == nullptr) {
    napi_throw_type_error(env, "invalid_argument", "isReleased(handle) 收到无效句柄");
    return nullptr;
  }
  LockHandle* handle = static_cast<LockHandle*>(data);
  napi_value released;
  napi_get_boolean(env, handle->fd < 0, &released);
  return released;
}

/** 诊断：锁文件的 inode 身份。用于证明"锁文件身份不被 rename/unlink/recreate"。 */
napi_value LockFileIdentity(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
    napi_throw_type_error(env, "invalid_argument", "lockFileIdentity(stablePath) 需要 1 个字符串参数");
    return nullptr;
  }
  std::string path;
  if (!GetStringArgument(env, argv[0], &path)) {
    napi_throw_type_error(env, "invalid_argument", "lockFileIdentity(stablePath) 需要字符串路径");
    return nullptr;
  }
  struct stat stats;
  if (::stat(path.c_str(), &stats) != 0) {
    ThrowErrno(env, "stat", path, errno);
    return nullptr;
  }
  napi_value object;
  napi_create_object(env, &object);
  napi_value device;
  napi_create_double(env, static_cast<double>(stats.st_dev), &device);
  napi_set_named_property(env, object, "device", device);
  napi_value inode;
  napi_create_double(env, static_cast<double>(stats.st_ino), &inode);
  napi_set_named_property(env, object, "inode", inode);
  napi_value exists;
  napi_get_boolean(env, true, &exists);
  napi_set_named_property(env, object, "exists", exists);
  return object;
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_value open_and_try_lock;
  napi_create_function(env, "openAndTryLock", NAPI_AUTO_LENGTH, OpenAndTryLock, nullptr,
                       &open_and_try_lock);
  napi_set_named_property(env, exports, "openAndTryLock", open_and_try_lock);

  napi_value unlock_and_close;
  napi_create_function(env, "unlockAndClose", NAPI_AUTO_LENGTH, UnlockAndClose, nullptr,
                       &unlock_and_close);
  napi_set_named_property(env, exports, "unlockAndClose", unlock_and_close);

  napi_value is_released;
  napi_create_function(env, "isReleased", NAPI_AUTO_LENGTH, HandleIsReleased, nullptr, &is_released);
  napi_set_named_property(env, exports, "isReleased", is_released);

  napi_value lock_file_identity;
  napi_create_function(env, "lockFileIdentity", NAPI_AUTO_LENGTH, LockFileIdentity, nullptr,
                       &lock_file_identity);
  napi_set_named_property(env, exports, "lockFileIdentity", lock_file_identity);

  napi_value secure_write_file;
  napi_create_function(env, "secureWriteFile", NAPI_AUTO_LENGTH, SecureWriteFile, nullptr,
                       &secure_write_file);
  napi_set_named_property(env, exports, "secureWriteFile", secure_write_file);

  napi_value secure_delete_file;
  napi_create_function(env, "secureDeleteFile", NAPI_AUTO_LENGTH, SecureDeleteFile, nullptr,
                       &secure_delete_file);
  napi_set_named_property(env, exports, "secureDeleteFile", secure_delete_file);

  return exports;
}

#endif  // _WIN32
