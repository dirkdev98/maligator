use icu_decimal::provider::{DecimalDigitsV1, DecimalSymbolsV1};
use icu_provider::prelude::*;
use std::cell::RefCell;

#[path = "intl_decimal_digits.rs"]
mod data;

#[derive(Default)]
pub(super) struct DecimalProvider {
    pub numbering_system: RefCell<Option<Box<DataMarkerAttributes>>>,
}

pub(super) fn supports_digits(system: &str) -> bool {
    data::DIGITS
        .binary_search_by_key(&system, |(name, _)| name)
        .is_ok()
}

impl DataProvider<DecimalSymbolsV1> for DecimalProvider {
    fn load(&self, request: DataRequest) -> Result<DataResponse<DecimalSymbolsV1>, DataError> {
        icu_decimal::provider::Baked.load(request)
    }
}

impl DataProvider<DecimalDigitsV1> for DecimalProvider {
    fn load(&self, request: DataRequest) -> Result<DataResponse<DecimalDigitsV1>, DataError> {
        let system = request.id.marker_attributes.as_str();
        let response =
            if let Ok(index) = data::DIGITS.binary_search_by_key(&system, |(name, _)| name) {
                DataResponse {
                    metadata: Default::default(),
                    payload: DataPayload::from_static_ref(&data::DIGITS[index].1),
                }
            } else {
                icu_decimal::provider::Baked.load(request)?
            };
        *self.numbering_system.borrow_mut() = Some(request.id.marker_attributes.to_owned());
        Ok(response)
    }
}
