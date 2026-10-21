use std::{
    io,
    process::{Child, Command},
};
#[cfg(windows)]
mod platform {
    use super::*;
    use std::os::windows::{io::AsRawHandle, process::CommandExt};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::*,
            JobObjects::*,
            ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };
    pub struct Tree {
        job: usize,
        pid: u32,
    }
    unsafe impl Send for Tree {}
    unsafe impl Sync for Tree {}
    impl Drop for Tree {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.job as HANDLE);
            }
        }
    }
    impl Tree {
        pub fn spawn(cmd: &mut Command) -> io::Result<(Child, Self)> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of_val(&limits) as u32,
                ) == 0
                {
                    CloseHandle(job);
                    return Err(io::Error::last_os_error());
                }
                cmd.creation_flags(0x08000000 | 0x00000004);
                let mut child = match cmd.spawn() {
                    Ok(v) => v,
                    Err(e) => {
                        CloseHandle(job);
                        return Err(e);
                    }
                };
                if AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
                    let _ = child.kill();
                    let _ = child.wait();
                    CloseHandle(job);
                    return Err(io::Error::last_os_error());
                }
                let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
                let mut entry: THREADENTRY32 = std::mem::zeroed();
                entry.dwSize = std::mem::size_of_val(&entry) as u32;
                let mut resumed = false;
                if snapshot != INVALID_HANDLE_VALUE && Thread32First(snapshot, &mut entry) != 0 {
                    loop {
                        if entry.th32OwnerProcessID == child.id() {
                            let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                            if !thread.is_null() {
                                resumed = ResumeThread(thread) != u32::MAX;
                                CloseHandle(thread);
                            }
                            break;
                        }
                        if Thread32Next(snapshot, &mut entry) == 0 {
                            break;
                        }
                    }
                }
                if snapshot != INVALID_HANDLE_VALUE {
                    CloseHandle(snapshot);
                }
                if !resumed {
                    TerminateJobObject(job, 1);
                    let _ = child.wait();
                    CloseHandle(job);
                    return Err(io::Error::other("Cannot resume contained worker"));
                }
                let pid = child.id();
                Ok((
                    child,
                    Self {
                        job: job as usize,
                        pid,
                    },
                ))
            }
        }
        pub fn terminate(&self, _marker: &str) {
            unsafe {
                TerminateJobObject(self.job as HANDLE, 1);
            }
        }
        pub fn pids(&self) -> Vec<u32> {
            unsafe {
                let mut data = vec![0usize; 4098];
                if QueryInformationJobObject(
                    self.job as HANDLE,
                    JobObjectBasicProcessIdList,
                    data.as_mut_ptr() as *mut _,
                    (data.len() * std::mem::size_of::<usize>()) as u32,
                    std::ptr::null_mut(),
                ) == 0
                {
                    return vec![self.pid];
                };
                let header = &*(data.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST);
                let count = header.NumberOfProcessIdsInList as usize;
                let list =
                    std::slice::from_raw_parts(header.ProcessIdList.as_ptr(), count.min(4096));
                list.iter().map(|p| *p as u32).collect()
            }
        }
        pub fn memory(&self) -> u64 {
            self.pids()
                .into_iter()
                .map(|pid| unsafe {
                    use windows_sys::Win32::System::Threading::{
                        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
                    };
                    let h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
                    if h.is_null() {
                        return 0;
                    }
                    let mut info: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
                    let result =
                        if GetProcessMemoryInfo(h, &mut info, std::mem::size_of_val(&info) as u32)
                            != 0
                        {
                            info.WorkingSetSize as u64
                        } else {
                            0
                        };
                    CloseHandle(h);
                    result
                })
                .sum()
        }
    }
    pub struct ManagerPipe(std::sync::Arc<std::fs::File>);
    impl ManagerPipe {
        pub fn try_clone(&self) -> io::Result<Self> { Ok(Self(self.0.clone())) }
        fn transfer(&self, buffer: *mut u8, length: usize, read: bool) -> io::Result<usize> {
            use windows_sys::Win32::{Foundation::{ERROR_BROKEN_PIPE, ERROR_IO_PENDING}, Storage::FileSystem::{ReadFile, WriteFile}, System::{IO::{GetOverlappedResult, OVERLAPPED}, Threading::CreateEventW}};
            // A synchronous pipe handle serializes reads and writes, even from two
            // threads. Each duplex operation needs its own overlapped event.
            unsafe {
                let event = CreateEventW(std::ptr::null(), 1, 0, std::ptr::null());
                if event.is_null() { return Err(io::Error::last_os_error()); }
                let mut overlapped: OVERLAPPED = std::mem::zeroed(); overlapped.hEvent = event;
                let mut count = 0;
                let handle = self.0.as_raw_handle() as HANDLE;
                let size = length.min(u32::MAX as usize) as u32;
                let ok = if read { ReadFile(handle, buffer, size, &mut count, &mut overlapped) }
                    else { WriteFile(handle, buffer as *const u8, size, &mut count, &mut overlapped) };
                let result = if ok == 0 && io::Error::last_os_error().raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                    Err(io::Error::last_os_error())
                } else if GetOverlappedResult(handle, &overlapped, &mut count, 1) == 0 {
                    Err(io::Error::last_os_error())
                } else { Ok(count as usize) };
                CloseHandle(event);
                match result { Err(error) if read && error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) => Ok(0), result => result }
            }
        }
    }
    impl io::Read for ManagerPipe {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> { if buffer.is_empty() { return Ok(0); } self.transfer(buffer.as_mut_ptr(), buffer.len(), true) }
    }
    impl io::Write for ManagerPipe {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> { if buffer.is_empty() { return Ok(0); } self.transfer(buffer.as_ptr() as *mut u8, buffer.len(), false) }
        fn flush(&mut self) -> io::Result<()> { Ok(()) }
    }
    pub fn manager_pipe(path: &str) -> io::Result<ManagerPipe> {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OVERLAPPED;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(FILE_FLAG_OVERLAPPED)
            .open(path)?;
        Ok(ManagerPipe(std::sync::Arc::new(file)))
    }
}
#[cfg(unix)]
mod platform {
    use super::*;
    use std::os::unix::process::CommandExt;
    pub struct Tree {
        pid: u32,
    }
    impl Tree {
        pub fn spawn(cmd: &mut Command) -> io::Result<(Child, Self)> {
            unsafe {
                cmd.pre_exec(|| {
                    if libc::setpgid(0, 0) == 0 {
                        Ok(())
                    } else {
                        Err(io::Error::last_os_error())
                    }
                });
            }
            let child = cmd.spawn()?;
            let pid = child.id();
            Ok((child, Self { pid }))
        }
        pub fn terminate(&self, marker: &str) {
            unsafe {
                libc::kill(-(self.pid as i32), libc::SIGTERM);
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
            unsafe {
                libc::kill(-(self.pid as i32), libc::SIGKILL);
            }
            for _ in 0..10 {
                let pids = marked_pids(marker);
                if pids.is_empty() {
                    break;
                }
                for pid in pids {
                    #[cfg(target_os = "macos")]
                    {
                        let identity = process_identity(pid);
                        if identity.is_none() || process_identity(pid) != identity {
                            continue;
                        }
                    }
                    unsafe {
                        libc::kill(pid as i32, libc::SIGKILL);
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }
        pub fn pids(&self) -> Vec<u32> {
            group_pids(self.pid)
        }
        pub fn memory(&self) -> u64 {
            self.pids().into_iter().map(resident_memory).sum()
        }
    }
    #[cfg(target_os = "macos")]
    mod darwin {
        #[link(name = "proc")]
        unsafe extern "C" {
            pub fn proc_listpids(kind: u32, id: u32, buffer: *mut libc::c_void, size: i32) -> i32;
            pub fn proc_pidinfo(
                pid: i32,
                flavor: i32,
                arg: u64,
                buffer: *mut libc::c_void,
                size: i32,
            ) -> i32;
        }
        // sys/proc_info.h; fixed-width ABI, MAXCOMLEN = 16.
        #[repr(C)]
        pub struct BsdInfo {
            pub flags: u32,
            pub status: u32,
            pub xstatus: u32,
            pub pid: u32,
            pub ppid: u32,
            pub uid: u32,
            pub gid: u32,
            pub ruid: u32,
            pub rgid: u32,
            pub svuid: u32,
            pub svgid: u32,
            pub reserved: u32,
            pub comm: [u8; 16],
            pub name: [u8; 32],
            pub nfiles: u32,
            pub pgid: u32,
            pub jobc: u32,
            pub tty: u32,
            pub tpgid: u32,
            pub nice: i32,
            pub start_sec: u64,
            pub start_usec: u64,
        }
        #[repr(C)]
        pub struct TaskInfo {
            pub virtual_size: u64,
            pub resident_size: u64,
            pub times: [u64; 4],
            pub stats: [i32; 12],
        }
        pub fn pids(kind: u32, id: u32) -> Vec<u32> {
            unsafe {
                let size = proc_listpids(kind, id, std::ptr::null_mut(), 0);
                if size <= 0 {
                    return vec![];
                }
                let mut pids = vec![0u32; (size as usize / 4) + 1024];
                let n = proc_listpids(
                    kind,
                    id,
                    pids.as_mut_ptr() as *mut _,
                    (pids.len() * 4) as i32,
                );
                if n <= 0 {
                    return vec![];
                }
                pids.truncate(n as usize / 4);
                pids.retain(|p| *p > 0);
                pids
            }
        }
        pub fn info(pid: u32) -> Option<BsdInfo> {
            unsafe {
                let mut info: BsdInfo = std::mem::zeroed();
                let size = std::mem::size_of_val(&info) as i32;
                if proc_pidinfo(pid as i32, 3, 0, &mut info as *mut _ as *mut _, size) == size {
                    Some(info)
                } else {
                    None
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    fn group_pids(pid: u32) -> Vec<u32> {
        darwin::pids(2, pid)
    }
    #[cfg(target_os = "macos")]
    fn resident_memory(pid: u32) -> u64 {
        unsafe {
            let mut info: darwin::TaskInfo = std::mem::zeroed();
            let size = std::mem::size_of_val(&info) as i32;
            if darwin::proc_pidinfo(pid as i32, 4, 0, &mut info as *mut _ as *mut _, size) == size {
                info.resident_size
            } else {
                0
            }
        }
    }
    #[cfg(target_os = "macos")]
    pub fn process_identity(pid: u32) -> Option<(u64, u64)> {
        darwin::info(pid).map(|info| (info.start_sec, info.start_usec))
    }
    #[cfg(not(target_os = "macos"))]
    fn group_pids(pid: u32) -> Vec<u32> {
        vec![pid]
    }
    #[cfg(not(target_os = "macos"))]
    fn resident_memory(_pid: u32) -> u64 {
        0
    }
    #[cfg(target_os = "macos")]
    pub fn marked_pids(marker: &str) -> Vec<u32> {
        let uid = unsafe { libc::getuid() };
        let needle = format!("__AI_USAGE_WORKER_UUID={}", marker);
        let mut found = vec![];
        for pid in darwin::pids(4, uid) {
            let Some(info) = darwin::info(pid) else {
                continue;
            };
            if info.uid != uid {
                continue;
            }
            let mut mib = [libc::CTL_KERN, 49, pid as i32];
            let mut length = 0usize;
            unsafe {
                if libc::sysctl(
                    mib.as_mut_ptr(),
                    3,
                    std::ptr::null_mut(),
                    &mut length,
                    std::ptr::null_mut(),
                    0,
                ) != 0
                    || length > 4 * 1024 * 1024
                    || length < 4
                {
                    continue;
                }
                let mut bytes = vec![0u8; length];
                if libc::sysctl(
                    mib.as_mut_ptr(),
                    3,
                    bytes.as_mut_ptr() as *mut _,
                    &mut length,
                    std::ptr::null_mut(),
                    0,
                ) != 0
                {
                    continue;
                }
                bytes.truncate(length);
                let argc = i32::from_ne_bytes(bytes[..4].try_into().unwrap());
                if argc < 0 || argc > 65536 {
                    continue;
                }
                let mut offset = 4;
                while offset < bytes.len() && bytes[offset] != 0 {
                    offset += 1
                }
                while offset < bytes.len() && bytes[offset] == 0 {
                    offset += 1
                }
                for _ in 0..argc {
                    while offset < bytes.len() && bytes[offset] != 0 {
                        offset += 1
                    }
                    offset += 1;
                }
                // Inspect environment entries only, never an argv value masquerading as a marker.
                if offset < bytes.len()
                    && bytes[offset..]
                        .split(|b| *b == 0)
                        .any(|entry| entry == needle.as_bytes())
                {
                    found.push(pid);
                }
                bytes.fill(0);
            }
        }
        found
    }
    #[cfg(not(target_os = "macos"))]
    pub fn marked_pids(_marker: &str) -> Vec<u32> {
        vec![]
    }

    pub fn manager_pipe(path: &str) -> io::Result<std::os::unix::net::UnixStream> {
        std::os::unix::net::UnixStream::connect(path)
    }
}
pub use platform::*;
