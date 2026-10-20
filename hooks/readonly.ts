// agy4claude's tool gates: an agy PreToolUse hook (perl, which macOS and Linux ship).
// agy has no read-only flag (its --mode plan only plans first), and its --mode accept-edits still runs
// commands under --dangerously-skip-permissions (checked 2026-10-20). So this hook is what keeps a plan run
// from changing anything (AGY4CLAUDE_READONLY=1) and an accept-edits run from running commands
// (AGY4CLAUDE_NO_COMMANDS=1). It is installed into each sign-in's ~/.gemini/config/hooks.json and
// does nothing, and prints nothing, unless one of those switches is set: agy reads a bare `{}` as a denial.

export const READONLY_HOOK_NAME = 'agy4claude-readonly'

/** agy's own tools that write: the hook allows them only on agy's files under ~/.gemini (its plan, scratch). */
export const READONLY_MATCHER = 'run_command|write_to_file|replace_file_content|multi_replace_file_content|edit_file|create_file|write_file|delete_file|code_action|send_command_input'

export const READONLY_HOOK = String.raw`#!/usr/bin/perl
# agy4claude tool gate: an agy PreToolUse hook. It does nothing unless AGY4CLAUDE_READONLY=1 or
# AGY4CLAUDE_NO_COMMANDS=1, which agy4claude sets only for runs with mode "plan" / "accept-edits".
# READONLY: lets inspection commands through and denies everything that could change something
# (tests, builds, installs, writes, edits). NO_COMMANDS: denies every command, lets edits through.
# "No opinion" is no output at all (a bare {} is read by agy as a denial).
use strict;
use warnings;
use JSON::PP;

my $raw = do { local $/; <STDIN> } // '';
my $json = JSON::PP->new->canonical;
sub out { print $json->encode($_[0]), "\n"; exit 0 }
my $readonly = ($ENV{AGY4CLAUDE_READONLY} // '') eq '1';
my $nocmd = ($ENV{AGY4CLAUDE_NO_COMMANDS} // '') eq '1';
exit 0 unless $readonly || $nocmd;

my $in = eval { $json->decode($raw) } || {};
my $call = $in->{toolCall} || {};
my $name = $call->{name} // '';
my $args = $call->{args} || {};
# Some agy builds hand over each argument JSON-encoded ("\"ls\""): unwrap those.
for my $k (keys %$args) {
  my $v = $args->{$k};
  if (defined $v && !ref $v && $v =~ /^"/) {
    my $d = eval { JSON::PP->new->allow_nonref->decode($v) };
    $args->{$k} = $d if defined $d && !ref $d;
  }
}

my $WHY = $readonly ? 'agy4claude plan mode is read-only' : 'agy4claude accept-edits mode does not run commands';
sub deny { out({ decision => 'deny', reason => "$WHY: $_[0]" }) }

if (!$readonly) {
  exit 0 unless $name eq 'run_command' || $name eq 'send_command_input';
  deny('edit files with the file tools, and say in your answer which commands should be run');
}

my %EDIT = map { $_ => 1 } qw(write_to_file replace_file_content multi_replace_file_content edit_file create_file write_file delete_file code_action send_command_input);
if ($EDIT{$name}) {
  # agy writes its own plan and scratch files under ~/.gemini; anything else is the user's.
  my $own = ($ENV{HOME} // '/nonexistent') . '/.gemini/';
  my @paths = map { my $p = $_; $p =~ s{^~/}{($ENV{HOME} // '') . '/'}e; $p } grep { defined && !ref && m{^(/|~)} } values %$args;
  deny('no file edits; put what you would change in your answer instead')
    if !@paths || grep { index($_, $own) != 0 || m{/\.\./} } @paths;
  out({ decision => 'allow' });
}
exit 0 unless $name eq 'run_command';

my $line = $args->{CommandLine} // $args->{command} // '';
my $verdict = check($line);
deny("'$line' is not allowed ($verdict). Only inspection commands run here: git diff/log/show/status/grep/blame/ls-files, ls, cat, head, tail, wc, grep, rg, find, sed -n, sort, diff and the like. Do not run tests, builds, installs or anything that writes; read the code instead and say what you would run.")
  if $verdict;
out({ decision => 'allow' });

# ---- the command check ---------------------------------------------------
# Returns '' when every part of the command line is a read-only inspection, else why not.

sub check {
  my ($s) = @_;
  my (@segs, @words, $w, $inw);
  my $push = sub { push @words, $w if $inw; $w = ''; $inw = 0 };
  my $end = sub { $push->(); push @segs, [@words] if @words; @words = () };
  $w = ''; $inw = 0;
  my @c = split //, $s;
  for (my $i = 0; $i < @c; $i++) {
    my $ch = $c[$i];
    if ($ch eq "'") {
      my $j = index($s, "'", $i + 1);
      return 'unclosed quote' if $j < 0;
      $w .= substr($s, $i + 1, $j - $i - 1); $inw = 1; $i = $j; next;
    }
    if ($ch eq '"') {
      my $j = $i + 1;
      for (; $j < @c; $j++) {
        last if $c[$j] eq '"';
        return 'command substitution' if $c[$j] eq chr(96) || ($c[$j] eq '$' && ($c[$j + 1] // '') eq '(');
        if ($c[$j] eq '\\') { $j++; $w .= $c[$j] // ''; next }
        $w .= $c[$j];
      }
      return 'unclosed quote' if $j >= @c;
      $inw = 1; $i = $j; next;
    }
    if ($ch eq '\\') { $w .= $c[++$i] // ''; $inw = 1; next }
    return 'command substitution' if $ch eq chr(96) || ($ch eq '$' && ($c[$i + 1] // '') eq '(');
    return 'process substitution' if ($ch eq '<' || $ch eq '>') && ($c[$i + 1] // '') eq '(';
    if ($ch eq '>' || ($ch eq '&' && ($c[$i + 1] // '') eq '>')) {
      # A redirection: only to /dev/null or onto another stream.
      $w = '', $inw = 0 if $inw && $w =~ /^\d$/;
      $push->();
      my $op = $ch; $op .= $c[++$i] while ($c[$i + 1] // '') =~ /[>&|]/;
      $i++ while ($c[$i + 1] // '') =~ /\s/;
      my $t = '';
      $t .= $c[++$i] while $i + 1 < @c && $c[$i + 1] !~ /[\s;|&<>]/;
      return "writes to $t" unless $t eq '/dev/null' || ($op =~ /&$/ && $t =~ /^\d$/) || ($op eq '>&' && $t =~ /^\d$/);
      next;
    }
    if ($ch eq '<') {
      $push->();
      $i++ while ($c[$i + 1] // '') eq '<';
      next;
    }
    if ($ch =~ /[;|&\n]/) { $end->(); $i++ while ($c[$i + 1] // '') =~ /[|&]/; next }
    if ($ch =~ /\s/) { $push->(); next }
    $w .= $ch; $inw = 1;
  }
  $end->();
  return 'empty command' unless @segs;
  for my $seg (@segs) {
    my $why = segment(@$seg);
    return $why if $why;
  }
  return '';
}

sub segment {
  my @a = @_;
  my $cmd = shift @a;
  return 'sets variables' if $cmd =~ /^[A-Za-z_][A-Za-z0-9_]*=/;
  $cmd =~ s{.*/}{};
  return '' if $cmd eq 'cd' || $cmd eq 'pwd' || $cmd eq 'true' || $cmd eq 'false';
  my %plain = map { $_ => 1 } qw(ls cat head tail wc grep egrep fgrep rg ag cut tr nl file stat echo printf which type
    diff cmp comm jq du df basename dirname realpath readlink date test [ column fold rev tac strings od hexdump
    shasum sha1sum sha256sum md5 md5sum cksum whoami uname hostname id expand unexpand paste join);
  if ($cmd eq 'rg') { return grep({ /^--pre/ } @a) ? 'rg --pre runs a command' : '' }
  if ($cmd eq 'tree') { return grep({ /^-o$/ } @a) ? 'tree -o writes a file' : '' }
  if ($cmd eq 'file') { return grep({ /^-[a-zA-Z]*C/ } @a) ? 'file -C writes a file' : '' }
  return '' if $plain{$cmd};
  if ($cmd eq 'sed') { return grep({ /^-[a-zA-Z]*i|^--in-place/ } @a) ? 'sed -i edits files' : '' }
  if ($cmd eq 'sort') { return grep({ /^-[a-zA-Z]*o|^--output/ } @a) ? 'sort -o writes a file' : '' }
  if ($cmd eq 'uniq') { return (grep { !/^-/ } @a) > 1 ? 'uniq with an output file' : '' }
  if ($cmd eq 'find') {
    return grep({ /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/ } @a) ? 'find with -exec or -delete' : '';
  }
  if ($cmd eq 'git') { return git(@a) }
  return "$cmd is not an inspection command";
}

sub git {
  my @a = @_;
  while (@a && $a[0] =~ /^-/) {
    my $o = shift @a;
    if ($o eq '-C' || $o eq '--git-dir' || $o eq '--work-tree') { shift @a; next }
    next if $o =~ /^--(no-pager|git-dir=|work-tree=|no-optional-locks|literal-pathspecs)/ || $o eq '-P';
    return "git $o";
  }
  my $sub = shift(@a) // '';
  return 'git --output writes a file' if grep { /^--output/ } @a;
  return 'git grep -O runs a command' if $sub eq 'grep' && grep { /^-O|^--open-files-in-pager/ } @a;
  my %read = map { $_ => 1 } qw(diff log show status grep blame ls-files ls-tree rev-parse rev-list merge-base describe
    shortlog cat-file whatchanged name-rev for-each-ref diff-tree diff-index diff-files show-ref count-objects show-branch);
  return '' if $read{$sub};
  my @rest = grep { !/^-/ } @a;
  return '' if $sub eq 'branch' && !@rest && !grep { /^-(d|D|m|M|c|C|f|u)$|^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)/ } @a;
  return '' if $sub eq 'tag' && (!@a || grep { /^(-l|--list|-n\d*)$/ } @a) && !grep { /^-(d|a|s|f|m)$/ } @a;
  return '' if $sub eq 'remote' && (!@rest || $rest[0] eq 'get-url' || $rest[0] eq 'show');
  return '' if $sub eq 'config' && grep { /^(--get|--get-all|--get-regexp|--list|-l)$/ } @a;
  return '' if ($sub eq 'stash' || $sub eq 'worktree') && @rest && $rest[0] eq 'list';
  return "git $sub can change the repository";
}
`
