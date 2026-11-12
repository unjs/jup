/*
 * §08.3.3 for the scriptc build — `execve(2)` behind a fixed signature that
 * scriptc's FFI can bind (it has no pointer-array class).
 *
 * `block` is every string NUL-terminated, back to back: the path, `argc`
 * argument strings, then `envc` `KEY=value` entries. Returns only on failure,
 * with `errno`; the caller reports §12.8's `cannotExecute`.
 */

#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int32_t jup_execve(const uint8_t *block, size_t length, int32_t argc, int32_t envc) {
  if (argc < 1 || envc < 0 || length == 0 || block[length - 1] != 0) return EINVAL;

  char *strings = malloc(length);
  char **argv = calloc((size_t)argc + 1, sizeof(char *));
  char **envp = calloc((size_t)envc + 1, sizeof(char *));
  if (strings == NULL || argv == NULL || envp == NULL) {
    free(strings);
    free(argv);
    free(envp);
    return ENOMEM;
  }
  memcpy(strings, block, length);

  /* Walk the block; each string must end inside it. */
  char *cursor = strings;
  char *end = strings + length;
  char *path = cursor;
  cursor += strlen(cursor) + 1;
  for (int32_t i = 0; i < argc + envc; i++) {
    if (cursor >= end) {
      free(strings);
      free(argv);
      free(envp);
      return EINVAL;
    }
    if (i < argc) argv[i] = cursor;
    else envp[i - argc] = cursor;
    cursor += strlen(cursor) + 1;
  }

  execve(path, argv, envp);
  int error = errno;
  free(strings);
  free(argv);
  free(envp);
  return error;
}
