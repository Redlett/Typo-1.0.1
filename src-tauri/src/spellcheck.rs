//! Native Windows 11 OS Spellchecker (`ISpellChecker` COM API) bridge.
//! Zero external dependencies, zero disk bloat (0 MB), sub-millisecond checking
//! against the built-in Windows English dictionary with real suggestions.

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NativeSpellError {
    pub word: String,
    pub suggestions: Vec<String>,
}

#[cfg(target_os = "windows")]
mod win_com {
    use super::NativeSpellError;
    use std::ffi::{c_void, OsString};
    use std::os::windows::ffi::OsStringExt;
    use std::ptr;

    type HRESULT = i32;
    type ULONG = u32;
    type LPCWSTR = *const u16;
    type LPWSTR = *mut u16;
    type BOOL = i32;

    #[repr(C)]
    struct GUID {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }

    const CLSID_SPELL_CHECKER_FACTORY: GUID = GUID {
        data1: 0x7AB36653,
        data2: 0x1796,
        data3: 0x484B,
        data4: [0xBD, 0xFA, 0xE7, 0x4F, 0x1D, 0xB7, 0xC1, 0xDC],
    };

    const IID_ISPELL_CHECKER_FACTORY: GUID = GUID {
        data1: 0x8E018A9D,
        data2: 0x2415,
        data3: 0x4677,
        data4: [0xBF, 0x08, 0x79, 0x4E, 0xA6, 0x1F, 0x94, 0xBB],
    };

    const CLSCTX_INPROC_SERVER: u32 = 0x1;
    const COINIT_APARTMENTTHREADED: u32 = 0x2;

    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(pvReserved: *mut c_void, dwCoInit: u32) -> HRESULT;
        fn CoCreateInstance(
            rclsid: *const GUID,
            pUnkOuter: *mut c_void,
            dwClsContext: u32,
            riid: *const GUID,
            ppv: *mut *mut c_void,
        ) -> HRESULT;
        fn CoTaskMemFree(pv: *mut c_void);
    }

    #[repr(C)]
    struct ISpellCheckerFactoryVtbl {
        query_interface: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
        add_ref: unsafe extern "system" fn(*mut c_void) -> ULONG,
        release: unsafe extern "system" fn(*mut c_void) -> ULONG,
        get_supported_languages: *const c_void,
        is_supported: unsafe extern "system" fn(*mut c_void, LPCWSTR, *mut BOOL) -> HRESULT,
        create_spell_checker: unsafe extern "system" fn(*mut c_void, LPCWSTR, *mut *mut ISpellChecker) -> HRESULT,
    }

    #[repr(C)]
    struct ISpellChecker {
        lp_vtbl: *const ISpellCheckerVtbl,
    }

    #[repr(C)]
    struct ISpellCheckerVtbl {
        query_interface: *const c_void,
        add_ref: *const c_void,
        release: unsafe extern "system" fn(*mut ISpellChecker) -> ULONG,
        get_language_tag: *const c_void,
        check: unsafe extern "system" fn(*mut ISpellChecker, LPCWSTR, *mut *mut IEnumSpellingError) -> HRESULT,
        suggest: unsafe extern "system" fn(*mut ISpellChecker, LPCWSTR, *mut *mut IEnumString) -> HRESULT,
        add: unsafe extern "system" fn(*mut ISpellChecker, LPCWSTR) -> HRESULT,
        ignore: unsafe extern "system" fn(*mut ISpellChecker, LPCWSTR) -> HRESULT,
    }

    #[repr(C)]
    struct IEnumSpellingError {
        lp_vtbl: *const IEnumSpellingErrorVtbl,
    }

    #[repr(C)]
    struct IEnumSpellingErrorVtbl {
        query_interface: *const c_void,
        add_ref: *const c_void,
        release: unsafe extern "system" fn(*mut IEnumSpellingError) -> ULONG,
        next: unsafe extern "system" fn(*mut IEnumSpellingError, *mut *mut ISpellingError) -> HRESULT,
    }

    #[repr(C)]
    struct ISpellingError {
        lp_vtbl: *const ISpellingErrorVtbl,
    }

    #[repr(C)]
    struct ISpellingErrorVtbl {
        query_interface: *const c_void,
        add_ref: *const c_void,
        release: unsafe extern "system" fn(*mut ISpellingError) -> ULONG,
        get_start_index: unsafe extern "system" fn(*mut ISpellingError, *mut u32) -> HRESULT,
        get_length: unsafe extern "system" fn(*mut ISpellingError, *mut u32) -> HRESULT,
        get_corrective_action: unsafe extern "system" fn(*mut ISpellingError, *mut i32) -> HRESULT,
        get_replacement: unsafe extern "system" fn(*mut ISpellingError, *mut LPWSTR) -> HRESULT,
    }

    #[repr(C)]
    struct IEnumString {
        lp_vtbl: *const IEnumStringVtbl,
    }

    #[repr(C)]
    struct IEnumStringVtbl {
        query_interface: *const c_void,
        add_ref: *const c_void,
        release: unsafe extern "system" fn(*mut IEnumString) -> ULONG,
        next: unsafe extern "system" fn(*mut IEnumString, ULONG, *mut LPWSTR, *mut ULONG) -> HRESULT,
    }

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn from_lpwstr(p: LPWSTR) -> String {
        if p.is_null() {
            return String::new();
        }
        let mut len = 0usize;
        while *p.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(p, len);
        OsString::from_wide(slice).to_string_lossy().into_owned()
    }

    pub fn check_words(words: &[String]) -> Vec<NativeSpellError> {
        if words.is_empty() {
            return Vec::new();
        }
        unsafe {
            let _ = CoInitializeEx(ptr::null_mut(), COINIT_APARTMENTTHREADED);
            let mut factory_ptr: *mut c_void = ptr::null_mut();
            let hr = CoCreateInstance(
                &CLSID_SPELL_CHECKER_FACTORY,
                ptr::null_mut(),
                CLSCTX_INPROC_SERVER,
                &IID_ISPELL_CHECKER_FACTORY,
                &mut factory_ptr,
            );
            if hr < 0 || factory_ptr.is_null() {
                return Vec::new();
            }
            let factory_vtbl = *(factory_ptr as *const *const ISpellCheckerFactoryVtbl);

            let mut checker: *mut ISpellChecker = ptr::null_mut();
            for tag in ["en-US", "en-GB", "en"] {
                let wtag = to_wide(tag);
                let mut supported: BOOL = 0;
                if ((*factory_vtbl).is_supported)(factory_ptr, wtag.as_ptr(), &mut supported) >= 0 && supported != 0 {
                    if ((*factory_vtbl).create_spell_checker)(factory_ptr, wtag.as_ptr(), &mut checker) >= 0
                        && !checker.is_null()
                    {
                        break;
                    }
                }
            }

            if checker.is_null() {
                ((*factory_vtbl).release)(factory_ptr);
                return Vec::new();
            }

            let checker_vtbl = &*(*checker).lp_vtbl;
            let mut results = Vec::new();

            for word in words {
                let wword = to_wide(word);
                let mut enum_err: *mut IEnumSpellingError = ptr::null_mut();
                if (checker_vtbl.check)(checker, wword.as_ptr(), &mut enum_err) >= 0 && !enum_err.is_null() {
                    let enum_vtbl = &*(*enum_err).lp_vtbl;
                    let mut err_obj: *mut ISpellingError = ptr::null_mut();
                    // S_OK == 0 means an error was found for this word
                    if (enum_vtbl.next)(enum_err, &mut err_obj) == 0 && !err_obj.is_null() {
                        let err_vtbl = &*(*err_obj).lp_vtbl;
                        let mut action: i32 = 0;
                        let _ = (err_vtbl.get_corrective_action)(err_obj, &mut action);
                        let mut suggestions = Vec::new();

                        if action == 2 {
                            // CORRECTIVE_ACTION_REPLACE
                            let mut rep: LPWSTR = ptr::null_mut();
                            if (err_vtbl.get_replacement)(err_obj, &mut rep) >= 0 && !rep.is_null() {
                                let s = from_lpwstr(rep);
                                CoTaskMemFree(rep as *mut c_void);
                                if !s.is_empty() {
                                    suggestions.push(s);
                                }
                            }
                        }

                        if suggestions.is_empty() {
                            let mut enum_sug: *mut IEnumString = ptr::null_mut();
                            if (checker_vtbl.suggest)(checker, wword.as_ptr(), &mut enum_sug) >= 0
                                && !enum_sug.is_null()
                            {
                                let sug_vtbl = &*(*enum_sug).lp_vtbl;
                                for _ in 0..5 {
                                    let mut s_ptr: LPWSTR = ptr::null_mut();
                                    let mut fetched: ULONG = 0;
                                    if (sug_vtbl.next)(enum_sug, 1, &mut s_ptr, &mut fetched) == 0 && !s_ptr.is_null() {
                                        let s = from_lpwstr(s_ptr);
                                        CoTaskMemFree(s_ptr as *mut c_void);
                                        if !s.is_empty() {
                                            suggestions.push(s);
                                        }
                                    } else {
                                        break;
                                    }
                                }
                                (sug_vtbl.release)(enum_sug);
                            }
                        }

                        (err_vtbl.release)(err_obj);
                        results.push(NativeSpellError {
                            word: word.clone(),
                            suggestions,
                        });
                    }
                    (enum_vtbl.release)(enum_err);
                }
            }

            (checker_vtbl.release)(checker);
            ((*factory_vtbl).release)(factory_ptr);
            results
        }
    }
}

#[cfg(target_os = "windows")]
pub fn check_words_native(words: Vec<String>) -> Vec<NativeSpellError> {
    win_com::check_words(&words)
}

#[cfg(not(target_os = "windows"))]
pub fn check_words_native(_words: Vec<String>) -> Vec<NativeSpellError> {
    Vec::new()
}
