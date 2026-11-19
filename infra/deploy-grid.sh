#!/usr/bin/env bash
#
# The device grid: Chrome slots and Android emulator slots on one EC2 host,
# each with an interactive noVNC view, behind a WebDriver URL the existing
# playwright-automation suite can be pointed at with one environment variable.
#
#   ./infra/deploy-grid.sh up        # create if needed, then start it
#   ./infra/deploy-grid.sh down      # STOP the instance (keeps the disk)
#   ./infra/deploy-grid.sh status    # where it is and what the URLs are
#   ./infra/deploy-grid.sh push      # send the compose file up and restart it
#   ./infra/deploy-grid.sh health    # per-slot health; a dead emulator shows here
#   ./infra/deploy-grid.sh install-apk <apk>   # put the driver app on every slot
#   ./infra/deploy-grid.sh restart [slot|all]  # recreate a slot (android-2) or everything
#   ./infra/deploy-grid.sh chrome off|on       # park the Chrome slots during a stress run
#   ./infra/deploy-grid.sh allow-ip  # re-point the security group at this IP
#   ./infra/deploy-grid.sh destroy   # terminate and delete everything
#
# There is NO SSH KEY and port 22 is never opened. Everything that has to reach
# the box goes through SSM, which authenticates as you rather than as whoever
# holds a .pem, leaves an audit trail, and cannot be reached from the internet
# at all. The ports in the security group are only the ones a human or the test
# suite actually talks to.
#
# `down` stops rather than terminates on purpose. The whole cost argument for
# running our own grid rests on the instance not being up between sweeps —
# $0.750/hr is $547/month left running and about three dollars a month if it
# only runs while a sweep does. Stopping keeps the EBS volume (~$8/month for
# 100GB gp3), which is what makes `up` take a minute instead of fifteen.
#
# WHY x86-64 AND NOT GRAVITON: Android emulators need KVM, and on EC2 /dev/kvm
# exists only when the instance was launched with nested virtualization, which
# AWS supports on C8i/M8i/R8i and explicitly NOT on Graviton. arm64 would
# otherwise be the cheaper host; it would need bare metal (c6g.metal, $2.176/hr
# against $0.750) to run emulators at all.
#
# WHY NOT CODEBUILD: a CodeBuild container has no inbound network, so it can
# neither serve a WebDriver endpoint nor carry an interactive session. That is
# the same constraint that made the existing live view push JPEGs to S3. The
# flow-map runner stays on CodeBuild and is untouched by this script.
#
# SECURITY: ports 4444 (WebDriver), 7901-7904 and 6081-6082 (noVNC) and 4723-
# 4724 (Appium) are opened to ONE address — whatever `curl checkip` says when
# you run this. A WebDriver endpoint is remote-code-execution-as-a-browser
# against staging, so it must never be 0.0.0.0/0. When your IP changes, run
# `allow-ip`; it replaces the rules rather than adding to them.
#
# Nothing here goes in dist/config.json. That file is world-readable by bucket
# policy, so the dashboard reads the grid's address from its own local config
# when you are running it at localhost:5173 for grid work.
#
# Requires: aws CLI v2 (authenticated), jq.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

if [[ -f "$HERE/deploy.env" ]]; then
  # shellcheck disable=SC1091
  source "$HERE/deploy.env"
fi

REGION="${REGION:-us-west-2}"
NAME="${GRID_NAME:-qa-grid}"
SG_NAME="${GRID_SG_NAME:-${NAME}-sg}"
# c8i is the cheapest family that can do nested virtualization at all. 4xlarge
# is 16 vCPU / 32 GiB: four Chrome slots and two emulators with headroom.
TYPE="${GRID_INSTANCE_TYPE:-c8i.4xlarge}"
DISK_GB="${GRID_DISK_GB:-100}"

# Ubuntu rather than Amazon Linux: docker-android is built and tested against
# Ubuntu, and the emulator's KVM setup is the part least worth improvising on.
AMI_PARAM="/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"

for tool in aws jq; do
  command -v "$tool" >/dev/null || { echo "error: $tool is required" >&2; exit 1; }
done

# To stderr, not stdout. Several of the functions below return a value by
# printing it and are called as "$(ensure_sg)" - a log line on stdout ends up
# inside that value, ANSI escapes and all, and AWS rejects the result as an
# invalid XML character in a security group id.
log() { printf '\n\033[1m==> %s\033[0m\n' "$*" >&2; }
die() { echo "error: $*" >&2; exit 1; }

aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 \
  || die "not authenticated. Refresh SSO, then run this again."

# ---------------------------------------------------------------- lookups --

my_ip() {
  local ip
  ip="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')"
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "could not determine this machine's public IP"
  printf '%s' "$ip"
}

instance_id() {
  aws ec2 describe-instances --region "$REGION" \
    --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null | grep -v '^None$' || true
}

sg_id() {
  aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=group-name,Values=$SG_NAME" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null | grep -v '^None$' || true
}

public_ip() {
  aws ec2 describe-instances --region "$REGION" --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text 2>/dev/null | grep -v '^None$' || true
}

state_of() {
  aws ec2 describe-instances --region "$REGION" --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo unknown
}

# Every port the grid serves, as "port description" pairs.
PORTS=(
  "4444 Selenium WebDriver - the URL the suite connects to"
  "7901 noVNC Chrome slot 1"
  "7902 noVNC Chrome slot 2"
  "7903 noVNC Chrome slot 3"
  "7904 noVNC Chrome slot 4"
  "4723 Appium Android slot 1 - Galaxy S10 / Android 14"
  "4724 Appium Android slot 2 - Galaxy S9 / Android 13"
  "4725 Appium Android slot 3 - Nexus 5 / Android 11"
  "4726 Appium Android slot 4 - Galaxy S6 / Android 9"
  "6081 noVNC Android slot 1"
  "6082 noVNC Android slot 2"
  "6083 noVNC Android slot 3"
  "6084 noVNC Android slot 4"
  "443  HTTPS - the grid behind TLS, for the deployed dashboard"
)

# Port 80 is the one exception to the one-address rule.
#
# Let's Encrypt validates by fetching http://<domain>/.well-known/acme-challenge
# from its own servers, which are not on anyone's allowlist, so 80 has to be
# open to the world or no certificate is ever issued or renewed. It serves
# nothing else -- every real route is on 443, which stays restricted like the
# rest of the grid. Without TLS the deployed dashboard cannot reach the grid at
# all, because an https page may not embed an http one.
ACME_PORT=80

# ---------------------------------------------------------- instance role --

ROLE_NAME="${GRID_ROLE_NAME:-${NAME}-role}"

# The instance needs exactly one thing: to be reachable by SSM, so the compose
# file can be delivered and the grid restarted without a key pair or an open
# port 22. It is given no access to S3, CodeBuild or anything else — a box that
# runs a browser someone can drive interactively is the last place to leave
# credentials lying around.
ensure_instance_profile() {
  local created=""
  if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    log "Creating instance role $ROLE_NAME"
    aws iam create-role --role-name "$ROLE_NAME" \
      --description "QA device grid host: SSM access only" \
      --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
    aws iam attach-role-policy --role-name "$ROLE_NAME" \
      --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore >/dev/null
  fi
  if ! aws iam get-instance-profile --instance-profile-name "$ROLE_NAME" >/dev/null 2>&1; then
    aws iam create-instance-profile --instance-profile-name "$ROLE_NAME" >/dev/null
    created=1
  fi
  # Checked separately from the profile's existence, because the two are
  # separate API calls and a run that fails between them leaves a profile with
  # no role in it. Treating "the profile exists" as "the profile is finished"
  # is how that wreckage survives every later run: run-instances accepts the
  # profile, the instance comes up with no credentials, and SSM never sees it.
  if [[ -z "$(aws iam get-instance-profile --instance-profile-name "$ROLE_NAME" \
                --query 'InstanceProfile.Roles[0].RoleName' --output text 2>/dev/null \
                | grep -v '^None$')" ]]; then
    aws iam add-role-to-instance-profile --instance-profile-name "$ROLE_NAME" \
      --role-name "$ROLE_NAME" >/dev/null
    created=1
  fi
  # IAM is eventually consistent and run-instances fails outright on a profile
  # it cannot see yet.
  [[ -n "${created:-}" ]] && sleep 12
  printf '%s' "$ROLE_NAME"
}

# Runs a command on the box as root and prints what it said. Replaces ssh.
on_host() {
  local id="$1" script="$2" cmd_id status payload
  # Through a FILE, not the --parameters shorthand. AWS-RunShellScript takes
  # `commands` as a list of lines, and the shorthand parser does not survive a
  # multi-line value: every newline arrives as a literal "n", which turns
  # `set -e` + `mkdir` into `set -emkdir` and the whole script into one broken
  # line. Splitting on newlines into a real JSON array is what the document
  # actually wants.
  payload="$(mktemp)"
  jq -Rs '{commands: split("\n")}' <<<"$script" > "$payload"
  cmd_id="$(aws ssm send-command --region "$REGION" --instance-ids "$id" \
    --document-name AWS-RunShellScript \
    --parameters "file://$payload" \
    --query 'Command.CommandId' --output text)"
  rm -f "$payload"
  for _ in $(seq 1 90); do
    status="$(aws ssm get-command-invocation --region "$REGION" \
      --command-id "$cmd_id" --instance-id "$id" \
      --query 'Status' --output text 2>/dev/null || echo Pending)"
    [[ "$status" == "Success" || "$status" == "Failed" || "$status" == "TimedOut" ]] && break
    sleep 5
  done
  aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" \
    --instance-id "$id" --query 'StandardOutputContent' --output text 2>/dev/null || true
  if [[ "$status" != "Success" ]]; then
    aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" \
      --instance-id "$id" --query 'StandardErrorContent' --output text 2>/dev/null || true
    return 1
  fi
}

# ------------------------------------------------------------ security group --

ensure_sg() {
  local id
  id="$(sg_id)"
  if [[ -z "$id" ]]; then
    log "Creating security group $SG_NAME"
    local vpc
    vpc="$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true \
             --query 'Vpcs[0].VpcId' --output text)"
    [[ "$vpc" != "None" && -n "$vpc" ]] || die "no default VPC in $REGION — set GRID_VPC_ID"
    id="$(aws ec2 create-security-group --region "$REGION" \
            --group-name "$SG_NAME" --vpc-id "${GRID_VPC_ID:-$vpc}" \
            --description "QA device grid: WebDriver, Appium and noVNC, one IP only" \
            --query 'GroupId' --output text)"
  fi
  printf '%s' "$id"
}

# Replaces the ingress rather than adding to it: a security group that
# accumulates every coffee shop you have ever worked from is the same as one
# open to the world, only harder to notice.
allow_ip() {
  local id ip
  id="$(ensure_sg)"
  ip="$(my_ip)"
  log "Restricting $SG_NAME to $ip/32"

  local existing
  existing="$(aws ec2 describe-security-groups --region "$REGION" --group-ids "$id" \
                --query 'SecurityGroups[0].IpPermissions' --output json)"
  if [[ "$existing" != "[]" && -n "$existing" ]]; then
    aws ec2 revoke-security-group-ingress --region "$REGION" \
      --group-id "$id" --ip-permissions "$existing" >/dev/null
  fi

  local perms='[]'
  for entry in "${PORTS[@]}"; do
    local port="${entry%% *}" desc="${entry#* }"
    perms="$(jq --argjson p "$port" --arg c "$ip/32" --arg d "$desc" \
      '. + [{IpProtocol:"tcp",FromPort:$p,ToPort:$p,IpRanges:[{CidrIp:$c,Description:$d}]}]' <<<"$perms")"
  done
  aws ec2 authorize-security-group-ingress --region "$REGION" \
    --group-id "$id" --ip-permissions "$perms" >/dev/null

  if [[ -n "${GRID_DOMAIN:-}" ]]; then
    aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$id" \
      --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":$ACME_PORT,\"ToPort\":$ACME_PORT,\"IpRanges\":[{\"CidrIp\":\"0.0.0.0/0\",\"Description\":\"ACME challenge only - Lets Encrypt validates from its own servers\"}]}]" \
      >/dev/null 2>&1 || true
    echo "  ${#PORTS[@]} ports open to $ip/32, plus :$ACME_PORT world-open for ACME" >&2
  else
    echo "  ${#PORTS[@]} ports open to $ip/32 and nothing else" >&2
  fi
  printf '%s' "$id"
}

# Write the current address into deploy.env so the dashboard deploy can publish
# it. Stopping and starting the instance hands back a different public IP, and a
# dashboard advertising last week's address is worse than one advertising none:
# the tab renders, the status line says "Not reachable", and the obvious reading
# is that the grid is down rather than that the config is stale.
remember_address() {
  local ip="$1" env_file="$HERE/deploy.env" url="http://$1:4444"
  [[ -f "$env_file" ]] || return 0
  if grep -q '^GRID_BASE_URL=' "$env_file"; then
    local tmp; tmp="$(mktemp)"
    sed "s|^GRID_BASE_URL=.*|GRID_BASE_URL=$url|" "$env_file" > "$tmp" && mv "$tmp" "$env_file"
  else
    printf '\n# Published in the deployed config.json so the Grid tab appears.\n# The noVNC password is NOT published - see infra/deploy.sh.\nGRID_BASE_URL=%s\n' "$url" >> "$env_file"
  fi
  echo "  deploy.env GRID_BASE_URL=$url" >&2
}

# ------------------------------------------------------------------ create --

user_data() {
  # Written to the instance at first boot. Idempotent on purpose: the instance
  # is stopped and started rather than recreated, and cloud-init only runs this
  # once, so everything it installs has to survive a reboot on its own.
  cat <<'CLOUDINIT'
#cloud-config
package_update: true
# No qemu package: /dev/kvm comes from the hypervisor once the instance was
# launched with NestedVirtualization=enabled, and `qemu-kvm` does not exist
# under that name on 24.04 - asking for it only makes cloud-init exit
# "error" on a boot that otherwise succeeded.
packages: [ca-certificates, curl, gnupg]
runcmd:
  - install -m 0755 -d /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  - chmod a+r /etc/apt/keyrings/docker.asc
  - echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
  - apt-get update
  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  - usermod -aG docker ubuntu
  - usermod -aG kvm ubuntu
  # Proof that nested virtualization actually took. Without the CPU option at
  # launch this device does not exist and every emulator slot fails to boot
  # with an error that blames the emulator rather than the host.
  - test -e /dev/kvm && echo "KVM present" > /var/log/qa-grid-kvm.log || echo "NO KVM — was the instance launched with NestedVirtualization=enabled?" > /var/log/qa-grid-kvm.log
  - systemctl enable --now docker
CLOUDINIT
}

create_instance() {
  local sg="$1" ami profile
  ami="$(aws ssm get-parameter --region "$REGION" --name "$AMI_PARAM" \
           --query 'Parameter.Value' --output text)"
  [[ -n "$ami" && "$ami" != "None" ]] || die "could not resolve the Ubuntu 24.04 AMI"
  profile="$(ensure_instance_profile)"

  log "Launching $TYPE ($ami) with nested virtualization"
  local id
  if cli_knows_nested_virt; then
    id="$(aws ec2 run-instances --region "$REGION" \
          --image-id "$ami" --instance-type "$TYPE" --count 1 \
          --security-group-ids "$sg" \
          --iam-instance-profile "Name=$profile" \
          --cpu-options "NestedVirtualization=enabled" \
          --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$DISK_GB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
          --metadata-options "HttpTokens=required,HttpEndpoint=enabled" \
          --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=Purpose,Value=qa-device-grid}]" \
          --user-data "$(user_data)" \
          --query 'Instances[0].InstanceId' --output text)"
  else
    id="$(launch_via_python "$ami" "$sg" "$profile")"
  fi
  echo "  $id" >&2
  printf '%s' "$id"
}

# Whether this CLI can even express the request.
#
# NestedVirtualization is rejected CLIENT-side by a CLI older than the February
# 2026 launch - the bundled botocore has no such field, so the parameter never
# reaches AWS and no amount of retrying helps. aws-cli 2.27 (May 2025) is one
# such CLI. The honest fix is to upgrade it; GRID_PYTHON is the way through
# without touching a root-owned system install.
cli_knows_nested_virt() {
  local out
  out="$(aws ec2 run-instances --region "$REGION" --dry-run \
          --image-id ami-00000000000000000 --instance-type "$TYPE" \
          --cpu-options "NestedVirtualization=enabled" 2>&1 || true)"
  # A CLI that understands the field gets as far as AWS and is refused for the
  # made-up AMI or by --dry-run; one that does not never leaves the machine.
  [[ "$out" != *"Unknown parameter in CpuOptions"* ]]
}

launch_via_python() {
  local ami="$1" sg="$2" profile="$3"
  [[ -n "${GRID_PYTHON:-}" ]] || die "$(cat <<'MSG'
this aws CLI predates nested virtualization and drops the parameter before it
is sent. Either upgrade it:

    curl -o /tmp/AWSCLIV2.pkg https://awscli.amazonaws.com/AWSCLIV2.pkg
    sudo installer -pkg /tmp/AWSCLIV2.pkg -target /

or point GRID_PYTHON at any python with a current boto3:

    python3 -m venv /tmp/awsvenv && /tmp/awsvenv/bin/pip install -U boto3
    GRID_PYTHON=/tmp/awsvenv/bin/python ./infra/deploy-grid.sh up
MSG
)"
  # user-data travels in the environment, not on stdin: stdin is the heredoc
  # holding this very script, so sys.stdin would already be exhausted and the
  # instance would boot with no cloud-init at all.
  GRID_USER_DATA="$(user_data)" \
  "$GRID_PYTHON" - "$ami" "$sg" "$profile" "$REGION" "$TYPE" "$DISK_GB" "$NAME" <<'PY'
import os, sys, boto3
ami, sg, profile, region, itype, disk, name = sys.argv[1:8]
ec2 = boto3.client("ec2", region_name=region)
r = ec2.run_instances(
    ImageId=ami, InstanceType=itype, MinCount=1, MaxCount=1,
    SecurityGroupIds=[sg],
    IamInstanceProfile={"Name": profile},
    CpuOptions={"NestedVirtualization": "enabled"},
    BlockDeviceMappings=[{"DeviceName": "/dev/sda1", "Ebs": {
        "VolumeSize": int(disk), "VolumeType": "gp3", "DeleteOnTermination": True}}],
    MetadataOptions={"HttpTokens": "required", "HttpEndpoint": "enabled"},
    TagSpecifications=[{"ResourceType": "instance", "Tags": [
        {"Key": "Name", "Value": name}, {"Key": "Purpose", "Value": "qa-device-grid"}]}],
    UserData=os.environ["GRID_USER_DATA"],
)
print(r["Instances"][0]["InstanceId"], end="")
PY
}

# -------------------------------------------------------------- reporting --

urls_for() {
  local ip="$1"
  cat <<EOF

  WebDriver   http://$ip:4444            ← SELENIUM_REMOTE_URL
  Grid UI     http://$ip:4444/ui

  Chrome      http://$ip:7901/?autoconnect=1&resize=scale   slot 1
              http://$ip:7902/?autoconnect=1&resize=scale   slot 2
              http://$ip:7903/?autoconnect=1&resize=scale   slot 3
              http://$ip:7904/?autoconnect=1&resize=scale   slot 4

  Android     http://$ip:6081  (Appium :4723)   Galaxy S10 / Android 14
              http://$ip:6082  (Appium :4724)   Galaxy S9  / Android 13
              http://$ip:6083  (Appium :4725)   Nexus 5    / Android 11
              http://$ip:6084  (Appium :4726)   Galaxy S6  / Android 9

  Point the suite at it — no code change, Playwright reads the variable and
  launches Chrome through the hub, so features/environment.py keeps calling
  browser_type.launch() and never learns it went remote:

      SELENIUM_REMOTE_URL=http://$ip:4444 \\
        behave -D env=staging -D browser=chromium -D headless=false

  headless=false is not optional here. utils/config.py defaults it to True,
  and a headless Chrome draws nothing on the container's X display — the run
  would work and every noVNC view would be an empty desktop. The grid is the
  one place where headless costs you the thing you came for.

  Stop paying for it when you are done:
      ./infra/deploy-grid.sh down
EOF
}

# ------------------------------------------------------------------- verbs --

cmd_up() {
  local sg id state ip
  sg="$(allow_ip)"
  id="$(instance_id)"

  if [[ -z "$id" ]]; then
    id="$(create_instance "$sg")"
  else
    state="$(state_of "$id")"
    echo "  found $id ($state)" >&2
    if [[ "$state" == "stopped" ]]; then
      log "Starting $id"
      aws ec2 start-instances --region "$REGION" --instance-ids "$id" >/dev/null
    fi
  fi

  log "Waiting for it to run"
  aws ec2 wait instance-running --region "$REGION" --instance-ids "$id"
  ip="$(public_ip "$id")"

  remember_address "$ip"

  log "Up"
  echo "  instance  $id"
  echo "  address   $ip"
  urls_for "$ip"
  cat <<EOF

  First boot installs Docker and takes a few minutes. Then:
      GRID_VNC_PASSWORD=... ./infra/deploy-grid.sh push
EOF
}

cmd_down() {
  local id
  id="$(instance_id)" || true
  [[ -n "$id" ]] || { echo "nothing to stop"; return 0; }
  log "Stopping $id — the disk is kept, so bringing it back is quick"
  aws ec2 stop-instances --region "$REGION" --instance-ids "$id" >/dev/null
  aws ec2 wait instance-stopped --region "$REGION" --instance-ids "$id"
  echo "  stopped. EBS keeps billing (~\$8/month for ${DISK_GB}GB); compute does not."
}

# Put the driver app on every emulator.
#
# Appium resolves the `app` capability on the SERVER, not the client, so a
# local path in staging.json means "a path on the grid host" and a session
# fails with "does not exist or is not accessible". The apk has to be on the
# device before the session starts; then the caps carry appPackage/appActivity
# and no `app` at all, which also makes a session start in ~4s instead of
# uploading 145MB each time.
#
# It travels by presigned URL rather than by giving this instance S3 access.
# The box runs a browser that anyone on the allowed IP can drive by hand; a
# role that can read a bucket is exactly the kind of thing not to leave on it.
# The URL expires in an hour and grants nothing after that.
cmd_install_apk() {
  local id apk bucket key url script
  apk="${1:-${GRID_APK:-}}"
  [[ -n "$apk" && -f "$apk" ]] || die "usage: $0 install-apk /path/to/app.apk (or set GRID_APK)"
  bucket="${GRID_APK_BUCKET:-$(aws lambda get-function-configuration \
            --function-name "${FLOW_FN_NAME:-qa-dashboard-run-flow}" --region "$REGION" \
            --query 'Environment.Variables.PLAN_BUCKET' --output text 2>/dev/null)}"
  [[ -n "$bucket" && "$bucket" != "None" ]] || die "no private bucket to stage the apk through; set GRID_APK_BUCKET"

  id="$(instance_id)" || true
  [[ -n "$id" ]] || die "no instance - './infra/deploy-grid.sh up'"

  key="grid/$(basename "$apk")"
  log "Staging $(basename "$apk") in s3://$bucket/$key"
  aws s3 cp "$apk" "s3://$bucket/$key" --region "$REGION" --only-show-errors
  url="$(aws s3 presign "s3://$bucket/$key" --region "$REGION" --expires-in 3600)"

  log "Installing on every emulator"
  script="$(cat <<EOS
set -e
# Kept at a stable path, not in /tmp: the tuner reinstalls from here after a
# slot is recreated, which is the only way to revive a dead emulator and
# throws away the installed app every time.
curl -fsSL -o /opt/qa-grid/app.apk '$url'
for n in 1 2 3 4; do
  docker cp /opt/qa-grid/app.apk qa-grid-android-\$n:/tmp/app.apk
  printf "android-\$n: "
  docker exec qa-grid-android-\$n sh -c "adb install -r -g /tmp/app.apk 2>&1 | tail -1"
done
EOS
  )"
  on_host "$id" "$script"
}

# Bring a slot back, or all of them.
#
# --force-recreate, NOT `docker compose restart`. A slot whose emulator died
# has a supervisord that gave up on it ("device entered FATAL state, too many
# start retries too quickly"), and restarting the container walks straight back
# into the same state -- tried it, it sat unbooted. Recreating gets a clean
# supervisord and boots in ~50s.
cmd_restart() {
  local id what script
  what="${1:-all}"
  id="$(instance_id)" || true
  [[ -n "$id" ]] || die "no instance"
  if [[ "$what" == "all" ]]; then
    script="cd /opt/qa-grid && docker compose ${GRID_DOMAIN:+--profile tls} up -d --force-recreate"
  elif [[ "$what" =~ ^(android|chrome)-[1-4]$ ]]; then
    script="cd /opt/qa-grid && docker compose up -d --force-recreate $what"
  else
    die "usage: $0 restart [all|android-1..4|chrome-1..4]"
  fi
  log "Recreating ${what}"
  on_host "$id" "$script
sleep 3
docker ps --format '{{.Names}}\t{{.Status}}' | sort"
}

# Give the emulators the whole machine.
#
# Four Chrome nodes are only ~250MB and ~1% CPU each at rest, so this is not
# really about reclaiming much -- it is about the host not having 16 cores'
# worth of claimants when four software-rendered emulators are all drawing maps
# at once. During a stress sweep the Selenium side is idle anyway.
cmd_chrome() {
  local id what
  what="${1:-}"
  id="$(instance_id)" || true
  [[ -n "$id" ]] || die "no instance"
  case "$what" in
    off) log "Stopping the Chrome slots and the hub"
         on_host "$id" "cd /opt/qa-grid && docker compose stop hub chrome-1 chrome-2 chrome-3 chrome-4
docker ps --format '{{.Names}}\t{{.Status}}' | sort" ;;
    on)  log "Starting the Chrome slots and the hub"
         on_host "$id" "cd /opt/qa-grid && docker compose start hub chrome-1 chrome-2 chrome-3 chrome-4
sleep 3
docker ps --format '{{.Names}}\t{{.Status}}' | sort" ;;
    *)   die "usage: $0 chrome {off|on}" ;;
  esac
}

# Container-level health, which is the only place a dead emulator shows up.
# Appium answers "ready" with no device attached, so neither the port nor the
# dashboard can tell you a slot is empty -- see the healthcheck in
# grid/docker-compose.yml.
cmd_health() {
  local id
  id="$(instance_id)" || true
  [[ -n "$id" ]] || die "no instance"
  [[ "$(state_of "$id")" == "running" ]] || die "instance is not running"
  on_host "$id" "docker ps --format '{{.Names}}\t{{.Status}}' | sort"
}

cmd_status() {
  local id state ip
  id="$(instance_id)" || true
  [[ -n "$id" ]] || { echo "no $NAME instance exists. ./infra/deploy-grid.sh up"; return 0; }
  state="$(state_of "$id")"
  echo "instance  $id"
  echo "state     $state"
  echo "type      $TYPE  ·  \$0.750/hr while running"
  if [[ "$state" == "running" ]]; then
    ip="$(public_ip "$id")"
    echo "address   $ip"
    urls_for "$ip"
  fi
}

# Ships the compose file through SSM and brings the grid up. The file travels
# base64-encoded inside the command rather than through S3: it is a few KB, and
# a bucket in the path would be one more thing to create, secure and forget.
cmd_push() {
  local id compose script
  id="$(instance_id)" || true
  [[ -n "$id" ]] || die "no instance — run 'up' first"
  [[ "$(state_of "$id")" == "running" ]] || die "instance is not running — './infra/deploy-grid.sh up'"
  : "${GRID_VNC_PASSWORD:?set GRID_VNC_PASSWORD — it is the noVNC login, so do not reuse anything}"

  log "Waiting for SSM to pick the instance up"
  for _ in $(seq 1 60); do
    [[ "$(aws ssm describe-instance-information --region "$REGION" \
            --filters "Key=InstanceIds,Values=$id" \
            --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)" == "Online" ]] && break
    sleep 10
  done

  log "Waiting for cloud-init to finish installing Docker"
  # First boot pulls Docker from apt; until that is done `docker compose` is
  # simply not a command, and the failure reads as a broken compose file
  # rather than a box that is not ready yet.
  # Gated on docker existing, not on cloud-init's own verdict. cloud-init
  # reports "status: error" when ANY package failed, including one nothing
  # depends on, so a boot that installed everything that matters still looks
  # failed - its extended_status spells this out as "error - done". What this
  # step actually needs is the docker binary.
  local ready=""
  for _ in $(seq 1 40); do
    if on_host "$id" 'command -v docker >/dev/null && echo DOCKER-READY' 2>/dev/null | grep -q 'DOCKER-READY'; then
      ready=1; break
    fi
    sleep 15
  done
  [[ -n "$ready" ]] || die "docker never appeared after 10 minutes. Check /var/log/cloud-init-output.log on the host."

  local ip
  ip="$(public_ip "$id")"
  [[ -n "$ip" ]] || die "instance has no public address"
  compose="$(base64 < "$HERE/grid/docker-compose.yml" | tr -d '\n')"
  local tuner caddyfile
  tuner="$(base64 < "$HERE/grid/tune.sh" | tr -d '\n')"
  caddyfile="$(base64 < "$HERE/grid/Caddyfile" | tr -d '\n')"
  script="$(cat <<EOF
set -e
mkdir -p /opt/qa-grid
echo '$compose' | base64 -d > /opt/qa-grid/docker-compose.yml
echo '$caddyfile' | base64 -d > /opt/qa-grid/Caddyfile
printf 'GRID_VNC_PASSWORD=%s\nGRID_PUBLIC_URL=%s\nGRID_DOMAIN=%s\n' '$GRID_VNC_PASSWORD' '${GRID_DOMAIN:+https://$GRID_DOMAIN}${GRID_DOMAIN:-http://$ip:4444}' '${GRID_DOMAIN:-}' > /opt/qa-grid/.env
chmod 600 /opt/qa-grid/.env
cat /var/log/qa-grid-kvm.log 2>/dev/null || echo "cloud-init has not finished yet"
echo '$tuner' | base64 -d > /opt/qa-grid/tune.sh
chmod +x /opt/qa-grid/tune.sh
cat > /etc/systemd/system/qa-grid-tuner.service <<'UNIT'
[Unit]
Description=Hold ANR dialogs off and animations at zero on every emulator
After=docker.service
Requires=docker.service
[Service]
ExecStart=/opt/qa-grid/tune.sh
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now qa-grid-tuner.service
systemctl restart qa-grid-tuner.service
cd /opt/qa-grid && docker compose ${GRID_DOMAIN:+--profile tls} up -d --force-recreate
docker compose ps --format '{{.Name}}\t{{.Status}}'
EOF
  )"
  log "Starting the grid"
  on_host "$id" "$script"
}

cmd_destroy() {
  local id sg
  id="$(instance_id)" || true
  if [[ -n "$id" ]]; then
    log "Terminating $id"
    aws ec2 terminate-instances --region "$REGION" --instance-ids "$id" >/dev/null
    aws ec2 wait instance-terminated --region "$REGION" --instance-ids "$id"
  fi
  sg="$(sg_id)" || true
  if [[ -n "$sg" ]]; then
    log "Deleting $SG_NAME"
    aws ec2 delete-security-group --region "$REGION" --group-id "$sg" >/dev/null
  fi
  if aws iam get-instance-profile --instance-profile-name "$ROLE_NAME" >/dev/null 2>&1; then
    log "Deleting $ROLE_NAME"
    aws iam remove-role-from-instance-profile --instance-profile-name "$ROLE_NAME" \
      --role-name "$ROLE_NAME" >/dev/null 2>&1 || true
    aws iam delete-instance-profile --instance-profile-name "$ROLE_NAME" >/dev/null 2>&1 || true
    aws iam detach-role-policy --role-name "$ROLE_NAME" \
      --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore >/dev/null 2>&1 || true
    aws iam delete-role --role-name "$ROLE_NAME" >/dev/null 2>&1 || true
  fi
  echo "  gone. Nothing from this script is still billing."
}

case "${1:-status}" in
  up)       cmd_up ;;
  down)     cmd_down ;;
  status)   cmd_status ;;
  push)     cmd_push ;;
  health)   cmd_health ;;
  restart)  shift; cmd_restart "${1:-all}" ;;
  chrome)   shift; cmd_chrome "${1:-}" ;;
  install-apk) shift; cmd_install_apk "${1:-}" ;;
  allow-ip) allow_ip >/dev/null ;;
  destroy)  cmd_destroy ;;
  *) echo "usage: $0 {up|down|status|push|health|restart [slot|all]|chrome {off|on}|install-apk <apk>|allow-ip|destroy}" >&2; exit 2 ;;
esac
