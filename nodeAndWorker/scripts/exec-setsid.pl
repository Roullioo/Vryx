#!/usr/bin/env perl
# Double fork + setsid : le processus final n'est plus enfant du shell (Cursor, etc.),
# ce qui évite les états bloqués (UE) et les soucis de job control avec rust-daemon.
use strict;
use warnings;
use POSIX qw(setsid);
@ARGV >= 1 or die "usage: exec-setsid.pl program [args...]\n";
$| = 1;

my $pid = fork();
die "fork: $!" unless defined $pid;
exit 0 if $pid;

POSIX::setsid() or die "setsid: $!\n";

$pid = fork();
die "fork2: $!" unless defined $pid;
exit 0 if $pid;

exec { $ARGV[0] } @ARGV or die "exec @ARGV: $!\n";
