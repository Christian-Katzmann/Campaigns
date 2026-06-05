#include <libgen.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/param.h>
#include <unistd.h>

int main(int argc, char *argv[]) {
    char executable_path[MAXPATHLEN];
    uint32_t size = sizeof(executable_path);

    if (_NSGetExecutablePath(executable_path, &size) != 0) {
        fprintf(stderr, "run stub: executable path too long\n");
        return 127;
    }

    char dir_buffer[MAXPATHLEN];
    strlcpy(dir_buffer, executable_path, sizeof(dir_buffer));
    char *dir = dirname(dir_buffer);

    char script_path[MAXPATHLEN];
    snprintf(script_path, sizeof(script_path), "%s/run.sh", dir);

    char **child_argv = calloc((size_t)argc + 2, sizeof(char *));
    if (!child_argv) {
        perror("calloc");
        return 127;
    }

    child_argv[0] = "/bin/bash";
    child_argv[1] = script_path;
    for (int i = 1; i < argc; i++) {
        child_argv[i + 1] = argv[i];
    }
    child_argv[argc + 1] = NULL;

    execv("/bin/bash", child_argv);
    perror("execv");
    return 127;
}
