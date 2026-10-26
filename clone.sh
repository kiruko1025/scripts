#!/usr/bin/env bash

set -euo pipefail

# Usage: ./clone.sh [github-username]
# Requires git and jq; public access also uses curl. Private access requires gh.

die() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "Install '$1' and try again."
}

authenticate() {
    require_command gh
    if ! gh auth status --hostname github.com >/dev/null 2>&1; then
        printf 'Sign in to GitHub with an account that can access the requested repositories.\n'
        gh auth login --hostname github.com --git-protocol https --web || die 'GitHub authentication failed.'
    fi
    authenticated=true
}

# Emit every public API page. Exit code 2 requests an authenticated retry.
public_repositories() {
    local page=1 response status body count
    while :; do
        response=$(curl --silent --show-error --location --write-out '\n%{http_code}' \
            -H 'Accept: application/vnd.github+json' \
            "https://api.github.com/users/$username/repos?type=owner&per_page=100&page=$page") || return 1
        status=${response##*$'\n'}
        body=${response%$'\n'*}
        case "$status" in
            200) ;;
            401|403|429) return 2 ;;
            *) printf 'GitHub returned HTTP %s for user %s.\n' "$status" "$username" >&2; return 1 ;;
        esac
        count=$(jq -er 'if type == "array" then length else error("Expected a repository list") end' <<< "$body") || return 1
        printf '%s\n' "$body"
        (( count < 100 )) && break
        page=$((page + 1))
    done
}

if (( $# > 1 )); then
    die "Usage: $0 [github-username]"
fi
if [[ ${1:-} == --help || ${1:-} == -h ]]; then
    printf 'Usage: %s [github-username]\nSelect public, private, or all repositories to clone into ~/Desktop.\n' "$0"
    exit 0
fi

username=${1:-}
if [[ -z $username ]]; then
    read -r -p 'GitHub username: ' username || die 'No GitHub username provided.'
fi
[[ $username =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$ && ${#username} -le 39 ]] \
    || die 'Enter a GitHub username, such as octocat (not a URL).'

while :; do
    read -r -p 'Which repositories? [1] public, [2] private, [3] all: ' selection \
        || die 'No repository type selected.'
    case "$selection" in
        1|[Pp][Uu][Bb][Ll][Ii][Cc]) repo_type=public; break ;;
        2|[Pp][Rr][Ii][Vv][Aa][Tt][Ee]) repo_type=private; break ;;
        3|[Aa][Ll][Ll]) repo_type=all; break ;;
        *) printf 'Please enter public, private, or all (or 1, 2, or 3).\n' ;;
    esac
done

require_command git
require_command jq
authenticated=false
if [[ $repo_type != public ]]; then
    authenticate
    printf 'Private repositories are limited to those your signed-in account can access.\n'
elif command -v gh >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1; then
    authenticated=true
else
    require_command curl
fi

printf 'Fetching %s repositories owned by %s...\n' "$repo_type" "$username"
public_json='[]'
private_json='[]'
if [[ $repo_type != private ]]; then
    if [[ $authenticated == false ]]; then
        if public_json=$(public_repositories); then
            :
        else
            status=$?
            (( status == 2 )) || die 'Could not fetch public repositories.'
            printf 'GitHub requires authentication or has rate-limited anonymous access.\n'
            authenticate
        fi
    fi
    if [[ $authenticated == true ]]; then
        public_json=$(gh api --hostname github.com --paginate \
            "users/$username/repos?type=owner&per_page=100") || die 'Could not fetch public repositories.'
    fi
fi
if [[ $repo_type != public ]]; then
    # /users/{username}/repos only lists public repositories, even after login.
    private_json=$(gh api --hostname github.com --paginate \
        'user/repos?visibility=private&affiliation=owner,collaborator,organization_member&per_page=100') \
        || die 'Could not fetch private repositories. Check your GitHub repository permissions.'
fi

# gh emits one JSON array per page. Filter by owner, including when cloning
# private repositories belonging to someone who granted us collaborator access.
repos=$(printf '%s\n%s\n' "$public_json" "$private_json" | jq -rs \
    --arg owner "$username" --arg visibility "$repo_type" '
    [ .[][]
      | select((.owner.login | ascii_downcase) == ($owner | ascii_downcase))
      | select($visibility == "all" or
          ($visibility == "private" and .private == true) or
          ($visibility == "public" and .private == false))
      | .full_name ] | unique[]') || die 'Could not parse the repository list.'

if [[ -z $repos ]]; then
    printf 'No accessible %s repositories found for %s.\n' "$repo_type" "$username"
    exit 0
fi

destination="$HOME/Desktop"
mkdir -p "$destination" || die "Could not create $destination."
cloned=0
skipped=0
failed=0
while IFS= read -r repo; do
    target="$destination/${repo#*/}"
    if [[ -e $target || -L $target ]]; then
        printf 'Skipping %s: %s already exists.\n' "$repo" "$target"
        skipped=$((skipped + 1))
        continue
    fi

    printf 'Cloning %s into %s...\n' "$repo" "$target"
    # Use HTTPS so an SSH key is not required. Keep the credential helper local
    # to this command instead of changing the user's global Git configuration.
    git_options=()
    if [[ $authenticated == true ]]; then
        git_options=(-c credential.helper= -c 'credential.https://github.com.helper=!gh auth git-credential')
    fi
    if git "${git_options[@]}" clone "https://github.com/$repo.git" "$target" </dev/null; then
        cloned=$((cloned + 1))
    else
        printf 'Failed to clone %s.\n' "$repo" >&2
        failed=$((failed + 1))
    fi
done <<< "$repos"

printf 'Finished: %d cloned, %d skipped, %d failed. Destination: %s\n' \
    "$cloned" "$skipped" "$failed" "$destination"
(( failed == 0 ))
